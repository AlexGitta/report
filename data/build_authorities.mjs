#!/usr/bin/env node
// Builds supabase/seed_authorities.sql from:
//   1. ONS Open Geography Portal: "Ward to LAD to County/UA to Region to Country (May 2026) Lookup in the UK"
//      (WD26_LAD26_CTYUA26_RGN26_CTRY26_UK_LU), queried for distinct LAD26/CTYUA26 pairs in England.
//      For a non-metropolitan district (E07) the CTYUA26 code is its county council (E10).
//   2. GOV.UK Local Links Manager API (homepage URLs), looked up by slug and verified against GSS code.
//
// Raw responses are cached in data/raw/. Re-run with --refresh to re-download everything.
// Usage: node data/build_authorities.mjs [--refresh]

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const RAW = join(here, 'raw');
const OUT = join(here, '..', 'supabase', 'seed_authorities.sql');
const REFRESH = process.argv.includes('--refresh');

const ONS_SERVICE = 'WD26_LAD26_CTYUA26_RGN26_CTRY26_UK_LU';
const ONS_URL =
  `https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services/${ONS_SERVICE}/FeatureServer/0/query?` +
  new URLSearchParams({
    where: "LAD26CD LIKE 'E%'",
    outFields: 'LAD26CD,LAD26NM,CTYUA26CD,CTYUA26NM',
    returnDistinctValues: 'true',
    returnGeometry: 'false',
    orderByFields: 'LAD26CD',
    resultRecordCount: '2000',
    f: 'json',
  });
const ONS_CACHE = join(RAW, 'ons_lad26_ctyua26_england.json');

const LLM_API = 'https://local-links-manager.publishing.service.gov.uk/api/local-authority?authority_slug=';
const LLM_CACHE = join(RAW, 'govuk_local_authorities.json');

// GOV.UK slugs that can't be derived by slugifying the ONS name, and cases where GOV.UK
// still records a legacy GSS code for the authority. gss -> { slug, govukGss? }
const SLUG_OVERRIDES = {
  E06000010: { slug: 'kingston-upon-hull' },
  E06000019: { slug: 'herefordshire' },
  E06000023: { slug: 'bristol' },
  E06000058: { slug: 'bournemouth-christchurch-poole' },
  E06000065: { slug: 'north-yorkshire', govukGss: 'E10000023' }, // GOV.UK keeps the pre-2023 county code
  E06000066: { slug: 'somerset', govukGss: 'E10000027' }, // GOV.UK keeps the pre-2023 county code
  E07000112: { slug: 'folkestone-hythe' },
  E08000038: { slug: 'barnsley', govukGss: 'E08000016' }, // GOV.UK keeps the pre-2021 code
  E08000039: { slug: 'sheffield', govukGss: 'E08000019' }, // GOV.UK keeps the pre-2021 code
};

async function getJson(url) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { headers: { 'user-agent': 'report-app-seed-builder' } });
    if (res.ok) return res.json();
    if (attempt >= 3 || res.status === 404) throw new Error(`${res.status} ${url}`);
    await new Promise((r) => setTimeout(r, 1000 * attempt));
  }
}

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[,.'’()]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

const sql = (v) => (v == null ? 'null' : `'${String(v).replace(/'/g, "''")}'`);

async function loadOns() {
  if (!REFRESH && existsSync(ONS_CACHE)) return JSON.parse(await readFile(ONS_CACHE, 'utf8'));
  const j = await getJson(ONS_URL);
  if (j.error) throw new Error(JSON.stringify(j.error));
  if (j.exceededTransferLimit) throw new Error('ONS query exceeded transfer limit – add paging');
  const rows = j.features.map((f) => f.attributes);
  const out = { source: ONS_URL, service: ONS_SERVICE, fetched_at: new Date().toISOString(), rows };
  await writeFile(ONS_CACHE, JSON.stringify(out, null, 1));
  return out;
}

async function loadWebsites(authorities) {
  const cache = !REFRESH && existsSync(LLM_CACHE) ? JSON.parse(await readFile(LLM_CACHE, 'utf8')) : { fetched_at: new Date().toISOString(), by_gss: {} };
  for (const a of authorities) {
    if (cache.by_gss[a.gss_code]) continue;
    const ov = SLUG_OVERRIDES[a.gss_code] ?? {};
    const slug = ov.slug ?? slugify(a.name);
    let hit = null;
    try {
      const j = await getJson(LLM_API + encodeURIComponent(slug));
      hit = (j.local_authorities ?? []).find((x) => x.gss === a.gss_code || (ov.govukGss && x.gss === ov.govukGss)) ?? null;
      if (hit) cache.by_gss[a.gss_code] = hit;
      // the response for a district also contains its county – cache that too
      for (const x of j.local_authorities ?? []) if (x.gss && !cache.by_gss[x.gss]) cache.by_gss[x.gss] = x;
    } catch (e) {
      /* 404 = slug guess wrong */
    }
    if (!hit) console.warn(`  no GOV.UK match for ${a.gss_code} ${a.name} (tried slug "${slug}")`);
  }
  cache.fetched_at = cache.fetched_at ?? new Date().toISOString();
  await writeFile(LLM_CACHE, JSON.stringify(cache, null, 1));
  return cache.by_gss;
}

await mkdir(RAW, { recursive: true });
const ons = await loadOns();

const auths = new Map();
for (const r of ons.rows) {
  const type = r.LAD26CD.slice(0, 3);
  if (!['E06', 'E07', 'E08', 'E09'].includes(type)) throw new Error(`unexpected LAD code ${r.LAD26CD}`);
  if (type === 'E07') {
    if (!r.CTYUA26CD.startsWith('E10')) throw new Error(`district ${r.LAD26CD} has non-county parent ${r.CTYUA26CD}`);
    auths.set(r.CTYUA26CD, { gss_code: r.CTYUA26CD, name: r.CTYUA26NM, type: 'E10', parent_gss: null });
  }
  const prev = auths.get(r.LAD26CD);
  const parent = type === 'E07' ? r.CTYUA26CD : null;
  if (prev && prev.parent_gss !== parent) throw new Error(`LAD ${r.LAD26CD} maps to multiple parents`);
  auths.set(r.LAD26CD, { gss_code: r.LAD26CD, name: r.LAD26NM, type, parent_gss: parent });
}

const list = [...auths.values()].sort((a, b) => a.gss_code.localeCompare(b.gss_code));
const web = await loadWebsites(list);
for (const a of list) {
  a.area_name = a.name;
  // Prefer the council name from GOV.UK (e.g. "Maidstone Borough Council") over the ONS area name ("Maidstone").
  a.name = web[a.gss_code]?.name ?? a.name;
  a.website = web[a.gss_code]?.homepage_url ?? null;
}

const counts = {};
for (const a of list) counts[a.type] = (counts[a.type] ?? 0) + 1;
console.log('counts', counts, 'total', list.length, 'with website', list.filter((a) => a.website).length);

const order = ['E10', 'E06', 'E07', 'E08', 'E09'];
const sorted = [...list].sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type) || a.gss_code.localeCompare(b.gss_code));
const lines = [
  '-- English local authorities (county councils, unitaries, districts, metropolitan districts, London boroughs).',
  `-- Generated by data/build_authorities.mjs on ${new Date().toISOString().slice(0, 10)}. Do not edit by hand.`,
  `-- Codes: ONS ${ons.service} (fetched ${ons.fetched_at.slice(0, 10)}). Council names + websites: GOV.UK Local Links Manager (fallback: ONS area name).`,
  `-- Counts: ${order.map((t) => `${t}=${counts[t] ?? 0}`).join(', ')}; total ${list.length}.`,
  '-- Counties (E10) are inserted first so parent_gss references resolve.',
  '',
  'insert into authorities (gss_code, name, type, parent_gss, website) values',
  sorted.map((a) => `  (${sql(a.gss_code)}, ${sql(a.name)}, ${sql(a.type)}, ${sql(a.parent_gss)}, ${sql(a.website)})`).join(',\n'),
  'on conflict (gss_code) do update set',
  '  name = excluded.name,',
  '  type = excluded.type,',
  '  parent_gss = excluded.parent_gss,',
  '  website = coalesce(excluded.website, authorities.website);',
  '',
];
await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, lines.join('\n'));
console.log('wrote', OUT);
