#!/usr/bin/env node
// Builds supabase/seed_contacts.sql: per-category council "report it" links (authority_contacts.form_url)
// from the GOV.UK Local Links Manager, keyed by GSS code and LGSL service code.
//
// Sources:
//   1. links_to_services_provided_by_local_authorities.csv – every council service link
//      (Authority Name, GSS, Description, LGSL, LGIL, URL, Title, Supported by GOV.UK). It has no link status.
//   2. Local Links Manager API /api/link?authority_slug=&lgsl=&lgil= – returns the link checker status
//      (ok / caution / broken / missing / pending) for one link. Only called for candidate links we'd use.
//   3. data/raw/ons_lad26_ctyua26_england.json + data/raw/govuk_local_authorities.json (from build_authorities.mjs)
//      for the set of known English GSS codes, GOV.UK slugs and GOV.UK's legacy GSS codes.
//
// Raw downloads are cached in data/raw/. Re-run with --refresh to re-download the CSV and re-check link statuses.
// Usage: node data/build_contacts.mjs [--refresh] [--ok-only]

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const RAW = join(here, 'raw');
const OUT = join(here, '..', 'supabase', 'seed_contacts.sql');
const REFRESH = process.argv.includes('--refresh');
const OK_ONLY = process.argv.includes('--ok-only');

const CSV_URL = 'https://local-links-manager.publishing.service.gov.uk/data/links_to_services_provided_by_local_authorities.csv';
const CSV_CACHE = join(RAW, 'local_links_services.csv');
const LINK_API = 'https://local-links-manager.publishing.service.gov.uk/api/link?';
const STATUS_CACHE = join(RAW, 'local_links_status.json');
const ONS_CACHE = join(RAW, 'ons_lad26_ctyua26_england.json');
const GOVUK_CACHE = join(RAW, 'govuk_local_authorities.json');

// Link checker statuses we accept. 'caution' = the checker got a warning rather than an error (typically the council
// site answers 403 to bots, or redirects); 'broken' = error (404, DNS, ...). Anything else (missing, pending, no API record) is rejected too.
// (On 2026-09-26 only ok / caution / broken were seen.)
// Pass --ok-only to drop 'caution' links too.
const GOOD_STATUS = new Set(OK_ONLY ? ['ok'] : ['ok', 'caution']);

// LGIL interaction codes (the part after ':' in Description).
const LGIL = { APPLY: 0, INFO: 8, REPORT: 17 };

// category slug -> ordered candidate [LGSL, LGIL] pairs. For each authority the first candidate that exists in the
// CSV, is "Supported by GOV.UK" and has a good link status wins. Keep in sync with the table in data/README.md.
const REPORT_FIRST = (lgsl) => [[lgsl, LGIL.REPORT], [lgsl, LGIL.APPLY], [lgsl, LGIL.INFO]];
const MAPPING = {
  pothole: [...REPORT_FIRST(557)], // Road maintenance
  damaged_pavement: [...REPORT_FIRST(537), [557, LGIL.REPORT], [557, LGIL.APPLY]], // Pavement maintenance, fallback Road maintenance
  road_markings_signs: [...REPORT_FIRST(559), [557, LGIL.REPORT], [557, LGIL.APPLY]], // Street furniture, fallback Road maintenance
  street_light: [...REPORT_FIRST(564)], // Street lighting
  overgrown_vegetation: [[557, LGIL.REPORT], [557, LGIL.APPLY]], // no vegetation service – generic highway fault form
  missed_bin: [...REPORT_FIRST(524)], // Household waste collection
  fly_tipping: [...REPORT_FIRST(587)], // Flytipping
  overflowing_litter_bin: [...REPORT_FIRST(580)], // Litter removal
  dog_fouling: [...REPORT_FIRST(577)], // Dog fouling
  drug_litter: [[428, LGIL.INFO], [580, LGIL.REPORT], [580, LGIL.APPLY]], // Syringe disposal (info only), fallback Litter removal
  graffiti: [...REPORT_FIRST(584)], // Graffiti removal
  abandoned_vehicle: [...REPORT_FIRST(372)], // Abandoned vehicles
  noise: [...REPORT_FIRST(412)], // Noise pollution
  asb: [[870, LGIL.INFO]], // Community safety (info only – no ASB reporting service in LGSL)
};

// routing_target per category (supabase/seed.sql) – decides which tier's link matters for coverage and seeding.
const HIGHWAY = new Set(['pothole', 'damaged_pavement', 'road_markings_signs', 'street_light', 'overgrown_vegetation']);

// Fallback for GOV.UK legacy GSS codes, in case govuk_local_authorities.json is missing an entry. current -> GOV.UK
const LEGACY_GSS = { E08000038: 'E08000016', E08000039: 'E08000019', E06000065: 'E10000023', E06000066: 'E10000027' };

const SPOT_CHECKS = [
  ['E10000016', 'pothole', 'Kent'],
  ['E07000110', 'missed_bin', 'Maidstone'],
  ['E08000003', 'fly_tipping', 'Manchester'],
  ['E09000007', 'graffiti', 'Camden'],
];

const sql = (v) => (v == null ? 'null' : `'${String(v).replace(/'/g, "''")}'`);

function parseCsv(text) {
  const rows = [];
  let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f.replace(/\r$/, '')); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}

async function loadCsv() {
  if (REFRESH || !existsSync(CSV_CACHE)) {
    // ~8 MB and the server drops connections, so use curl with retries + resume rather than fetch.
    const tmp = CSV_CACHE + '.part';
    const curl = process.platform === 'win32' ? 'curl.exe' : 'curl';
    execFileSync(curl, ['-sS', '-L', '--retry', '5', '--retry-all-errors', '-C', '-', '-o', tmp, CSV_URL], { stdio: 'inherit' });
    await rename(tmp, CSV_CACHE);
  }
  const [header, ...rows] = parseCsv(await readFile(CSV_CACHE, 'utf8')).filter((r) => r.length > 1);
  const want = ['Authority Name', 'GSS', 'Description', 'LGSL', 'LGIL', 'URL', 'Title', 'Supported by GOV.UK'];
  if (want.some((h, i) => header[i] !== h)) throw new Error(`unexpected CSV header: ${header.join(',')}`);
  for (const r of rows) if (r.length !== want.length) throw new Error(`bad CSV row: ${r.join(',')}`);
  return rows.map(([name, gss, description, lgsl, lgil, url, title, supported]) => ({
    name, gss, description, lgsl: +lgsl, lgil: +lgil, url: url.trim(), supported: supported === 'true',
  }));
}

async function getJson(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'report-app-seed-builder' } });
      if (res.status === 404) return null;
      // When rate limited GOV.UK answers 429 (or an HTML "too many attempts" page), so check the body is JSON.
      if (res.ok && (res.headers.get('content-type') ?? '').includes('json')) return res.json();
      if (attempt >= 8) throw new Error(`${res.status} ${url}`);
    } catch (e) {
      if (attempt >= 8) throw e;
    }
    await new Promise((r) => setTimeout(r, 15000 * attempt));
  }
}

// Known English authorities (same derivation as build_authorities.mjs) + GOV.UK slug and GOV.UK GSS code.
async function loadAuthorities() {
  const ons = JSON.parse(await readFile(ONS_CACHE, 'utf8'));
  const govuk = JSON.parse(await readFile(GOVUK_CACHE, 'utf8')).by_gss;
  const auths = new Map();
  for (const r of ons.rows) {
    if (r.LAD26CD.startsWith('E07')) auths.set(r.CTYUA26CD, { gss: r.CTYUA26CD, type: 'E10', parent: null });
    auths.set(r.LAD26CD, { gss: r.LAD26CD, type: r.LAD26CD.slice(0, 3), parent: r.LAD26CD.startsWith('E07') ? r.CTYUA26CD : null });
  }
  for (const a of auths.values()) {
    const g = govuk[a.gss];
    a.name = g?.name ?? a.gss;
    a.slug = g?.slug ?? null;
    a.govukGss = g?.gss ?? LEGACY_GSS[a.gss] ?? a.gss;
  }
  return auths;
}

await mkdir(RAW, { recursive: true });
const auths = await loadAuthorities();
const byGovukGss = new Map([...auths.values()].map((a) => [a.govukGss, a]));
const csv = await loadCsv();

// index: current gss -> "lgsl|lgil" -> row
const links = new Map();
let unknownGss = new Set();
for (const r of csv) {
  const a = byGovukGss.get(r.gss) ?? auths.get(r.gss);
  if (!a) { if (r.gss.startsWith('E')) unknownGss.add(`${r.gss} ${r.name}`); continue; }
  if (!links.has(a.gss)) links.set(a.gss, new Map());
  links.get(a.gss).set(`${r.lgsl}|${r.lgil}`, r);
}
if (unknownGss.size) console.warn('English GSS codes in CSV not in authorities (ignored):', [...unknownGss].join('; '));

const relevant = (slug, a) => (HIGHWAY.has(slug) ? a.type !== 'E07' : a.type !== 'E10');

// Link status cache: "slug|lgsl|lgil" -> status string (or null when the API has no such link).
const statusCache = !REFRESH && existsSync(STATUS_CACHE) ? JSON.parse(await readFile(STATUS_CACHE, 'utf8')) : { fetched_at: new Date().toISOString(), status: {} };
async function linkStatus(a, lgsl, lgil) {
  const key = `${a.slug}|${lgsl}|${lgil}`;
  if (!(key in statusCache.status)) {
    const j = await getJson(LINK_API + new URLSearchParams({ authority_slug: a.slug, lgsl, lgil }));
    statusCache.status[key] = j?.local_interaction ? { status: j.local_interaction.status ?? null, url: j.local_interaction.url ?? null } : null;
  }
  return statusCache.status[key];
}

// Resolve every (authority, category) in parallel with a small worker pool.
const jobs = [];
for (const a of auths.values()) for (const slug of Object.keys(MAPPING)) if (relevant(slug, a)) jobs.push({ a, slug });
const results = [];
const rejected = {}; // status -> count
let done = 0;
async function worker() {
  while (jobs.length) {
    const { a, slug } = jobs.shift();
    for (const [lgsl, lgil] of MAPPING[slug]) {
      const row = links.get(a.gss)?.get(`${lgsl}|${lgil}`);
      if (!row || !row.url || !row.supported) continue;
      if (!a.slug) { rejected['no slug'] = (rejected['no slug'] ?? 0) + 1; break; }
      const st = await linkStatus(a, lgsl, lgil);
      const status = st?.status ?? 'unknown';
      if (!GOOD_STATUS.has(status)) { rejected[status] = (rejected[status] ?? 0) + 1; continue; }
      // Prefer the API's URL (same data, but current); fall back to the CSV.
      results.push({ gss: a.gss, slug, url: st.url || row.url, lgsl, lgil, description: row.description, status });
      break;
    }
    if (++done % 500 === 0) {
      console.log(`  ${done} checked`);
      await writeFile(STATUS_CACHE, JSON.stringify(statusCache, null, 1));
    }
  }
}
await Promise.all(Array.from({ length: 4 }, worker));
await writeFile(STATUS_CACHE, JSON.stringify(statusCache, null, 1));

results.sort((x, y) => x.gss.localeCompare(y.gss) || Object.keys(MAPPING).indexOf(x.slug) - Object.keys(MAPPING).indexOf(y.slug));

// Coverage
console.log('\nrejected candidate links by status:', rejected);
console.log('\ncoverage (authorities with a link / relevant authorities):');
const coverage = [];
for (const slug of Object.keys(MAPPING)) {
  const rel = [...auths.values()].filter((a) => relevant(slug, a)).length;
  const mine = results.filter((r) => r.slug === slug);
  const byCode = {};
  for (const r of mine) { const k = `${r.lgsl}/${r.lgil}`; byCode[k] = (byCode[k] ?? 0) + 1; }
  coverage.push({ slug, tier: HIGHWAY.has(slug) ? 'highway' : 'district/unitary', have: mine.length, of: rel, byCode });
  console.log(`  ${slug.padEnd(24)} ${String(mine.length).padStart(3)}/${rel} (${Math.round((100 * mine.length) / rel)}%)  by LGSL/LGIL ${JSON.stringify(byCode)}`);
}
console.log('\nspot checks:');
for (const [gss, slug, label] of SPOT_CHECKS) {
  const r = results.find((x) => x.gss === gss && x.slug === slug);
  console.log(`  ${label} ${slug}: ${r ? `${r.url} [LGSL ${r.lgsl} LGIL ${r.lgil}, ${r.status}]` : '(none)'}`);
}

const lines = [
  '-- Per-category council reporting links (authority_contacts.form_url) from GOV.UK Local Links Manager.',
  `-- Generated by data/build_contacts.mjs on ${new Date().toISOString().slice(0, 10)}. Do not edit by hand.`,
  '-- Only links marked "Supported by GOV.UK" with link-checker status ok/caution are included. email is always null (signpost only).',
  `-- Rows: ${results.length}. Idempotent: rows with notes like 'GOV.UK Local Links%' are replaced; hand-entered contacts are untouched.`,
  '',
  "delete from public.authority_contacts where notes like 'GOV.UK Local Links%';",
  '',
  'insert into public.authority_contacts (authority_gss, category_group, category_id, email, form_url, notes)',
  'select v.authority_gss, c.category_group, c.id, null, v.form_url, v.notes',
  'from (values',
  results.map((r) => `  (${sql(r.gss)}, ${sql(r.slug)}, ${sql(r.url)}, ${sql(`GOV.UK Local Links LGSL ${r.lgsl} LGIL ${r.lgil} (${r.description}) [${r.status}]`)})`).join(',\n'),
  ') as v (authority_gss, slug, form_url, notes)',
  'join public.categories c on c.slug = v.slug',
  'join public.authorities a on a.gss_code = v.authority_gss;',
  '',
];
await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, lines.join('\n'));
console.log('\nwrote', OUT, results.length, 'rows');
