#!/usr/bin/env node
// Builds supabase/seed_police.sql from the data.police.uk API (https://data.police.uk/docs/).
//   GET /api/forces          -> list of forces (id = police.uk slug, used as police_forces.id)
//   GET /api/forces/<id>     -> detail (url, telephone, engagement_methods) — often incomplete
//
// England only: Welsh forces, PSNI and any Scottish force are excluded. British Transport Police
// is included if the API lists it (it currently does not; see README).
//
// report_url: the API exposes no dedicated online-reporting URL for any force, so we use the force
// website (API `url` / `web` engagement method if present, else the curated WEBSITES map below).
// non_emergency_url: 'tel:101' for every force.
//
// Raw responses are cached in data/raw/police_forces_api.json. Re-run with --refresh to re-download.
// Usage: node data/build_police.mjs [--refresh]

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const RAW = join(here, 'raw', 'police_forces_api.json');
const OUT = join(here, '..', 'supabase', 'seed_police.sql');
const REFRESH = process.argv.includes('--refresh');
const API = 'https://data.police.uk/api/forces';

const EXCLUDE = new Set(['dyfed-powys', 'gwent', 'north-wales', 'south-wales', 'northern-ireland', 'police-scotland', 'scotland']);

// Canonical force websites (the API's `url` field is missing, empty or http:// for many forces).
const WEBSITES = {
  'avon-and-somerset': 'https://www.avonandsomerset.police.uk/',
  bedfordshire: 'https://www.beds.police.uk/',
  'british-transport-police': 'https://www.btp.police.uk/',
  cambridgeshire: 'https://www.cambs.police.uk/',
  cheshire: 'https://www.cheshire.police.uk/',
  'city-of-london': 'https://www.cityoflondon.police.uk/',
  cleveland: 'https://www.cleveland.police.uk/',
  cumbria: 'https://www.cumbria.police.uk/',
  derbyshire: 'https://www.derbyshire.police.uk/',
  'devon-and-cornwall': 'https://www.devon-cornwall.police.uk/',
  dorset: 'https://www.dorset.police.uk/',
  durham: 'https://www.durham.police.uk/',
  essex: 'https://www.essex.police.uk/',
  gloucestershire: 'https://www.gloucestershire.police.uk/',
  'greater-manchester': 'https://www.gmp.police.uk/',
  hampshire: 'https://www.hampshire.police.uk/',
  hertfordshire: 'https://www.herts.police.uk/',
  humberside: 'https://www.humberside.police.uk/',
  kent: 'https://www.kent.police.uk/',
  lancashire: 'https://www.lancashire.police.uk/',
  leicestershire: 'https://www.leics.police.uk/',
  lincolnshire: 'https://www.lincs.police.uk/',
  merseyside: 'https://www.merseyside.police.uk/',
  metropolitan: 'https://www.met.police.uk/',
  norfolk: 'https://www.norfolk.police.uk/',
  'north-yorkshire': 'https://www.northyorkshire.police.uk/',
  northamptonshire: 'https://www.northants.police.uk/',
  northumbria: 'https://www.northumbria.police.uk/',
  nottinghamshire: 'https://www.nottinghamshire.police.uk/',
  'south-yorkshire': 'https://www.southyorkshire.police.uk/',
  staffordshire: 'https://www.staffordshire.police.uk/',
  suffolk: 'https://www.suffolk.police.uk/',
  surrey: 'https://www.surrey.police.uk/',
  sussex: 'https://www.sussex.police.uk/',
  'thames-valley': 'https://www.thamesvalley.police.uk/',
  warwickshire: 'https://www.warwickshire.police.uk/',
  'west-mercia': 'https://www.westmercia.police.uk/',
  'west-midlands': 'https://www.westmidlands.police.uk/',
  'west-yorkshire': 'https://www.westyorkshire.police.uk/',
  wiltshire: 'https://www.wiltshire.police.uk/',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJson(url) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { headers: { 'user-agent': 'report-app-seed-builder' } });
    if (res.ok) return res.json();
    // data.police.uk rate-limits bursts (429); back off and retry
    if (attempt >= 6 || res.status === 404) throw new Error(`${res.status} ${url}`);
    await sleep(1500 * attempt);
  }
}

async function load() {
  if (!REFRESH && existsSync(RAW)) return JSON.parse(await readFile(RAW, 'utf8'));
  const list = await getJson(API);
  const forces = [];
  for (const f of list) {
    forces.push(await getJson(`${API}/${f.id}`));
    await sleep(300);
  }
  const out = { source: API, fetched_at: new Date().toISOString(), list, forces };
  await mkdir(dirname(RAW), { recursive: true });
  await writeFile(RAW, JSON.stringify(out, null, 1));
  return out;
}

const sql = (v) => (v == null ? 'null' : `'${String(v).replace(/'/g, "''")}'`);

const raw = await load();
const rows = [];
for (const f of raw.forces) {
  if (EXCLUDE.has(f.id)) continue;
  const website = WEBSITES[f.id];
  if (!website) throw new Error(`no website mapping for force ${f.id} – add it to WEBSITES (and check it is English)`);
  const apiUrl = f.url || (f.engagement_methods ?? []).find((e) => e.type === 'web' && e.url)?.url || null;
  if (apiUrl && new URL(apiUrl).hostname.replace(/^www\./, '') !== new URL(website).hostname.replace(/^www\./, '')) {
    console.warn(`  note: ${f.id} API url ${apiUrl} differs from curated ${website}`);
  }
  rows.push({ id: f.id, name: f.name, report_url: website, non_emergency_url: 'tel:101' });
}
rows.sort((a, b) => a.id.localeCompare(b.id));
if (!rows.some((r) => r.id === 'british-transport-police')) console.warn('  note: british-transport-police not listed by the API – not seeded');
console.log('forces', rows.length);

const lines = [
  '-- Police forces in England (data.police.uk force slugs).',
  `-- Generated by data/build_police.mjs on ${new Date().toISOString().slice(0, 10)} from ${API} (fetched ${raw.fetched_at.slice(0, 10)}). Do not edit by hand.`,
  '-- Excludes Welsh forces (dyfed-powys, gwent, north-wales, south-wales) and PSNI.',
  '-- report_url is the force website (the API exposes no reporting URL); non_emergency_url is tel:101.',
  '',
  'insert into police_forces (id, name, report_url, non_emergency_url) values',
  rows.map((r) => `  (${sql(r.id)}, ${sql(r.name)}, ${sql(r.report_url)}, ${sql(r.non_emergency_url)})`).join(',\n'),
  'on conflict (id) do update set',
  '  name = excluded.name,',
  '  report_url = excluded.report_url,',
  '  non_emergency_url = excluded.non_emergency_url;',
  '',
];
await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, lines.join('\n'));
console.log('wrote', OUT);
