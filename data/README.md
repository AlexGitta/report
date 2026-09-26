# Reference data

Seed data for `authorities` and `police_forces`. `authority_contacts` is intentionally left empty.

| Output | Script | Rows |
|---|---|---|
| `supabase/seed_authorities.sql` | `data/build_authorities.mjs` | 317: E10=21, E06=63, E07=164, E08=36, E09=33 |
| `supabase/seed_police.sql` | `data/build_police.mjs` | 39 English territorial forces |

Both scripts need Node 22+ and have no npm dependencies. Every row is an upsert (`on conflict ... do update`), so you can re-run the seeds safely. In `seed_authorities.sql` the county councils (E10) come first as a separate statement, so the `parent_gss` foreign keys resolve.

## Regenerating

```sh
node data/build_authorities.mjs            # rebuild from cached raw files in data/raw/
node data/build_authorities.mjs --refresh  # re-download ONS + GOV.UK data
node data/build_police.mjs [--refresh]
```

When ONS publishes a newer vintage (for example the May 2027 lookup after Surrey reorganises), update `ONS_SERVICE` and the `LAD26*/CTYUA26*` field names in `build_authorities.mjs`, then run with `--refresh`.

## Sources (fetched 2026-09-26)

### Authorities
- **Codes, names and the district→county hierarchy** come from the ONS Open Geography Portal, *Ward to Local Authority District to County and Unitary Authority to Region to Country (May 2026) Lookup in the UK*. The feature service is `WD26_LAD26_CTYUA26_RGN26_CTRY26_UK_LU`: https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services/WD26_LAD26_CTYUA26_RGN26_CTRY26_UK_LU/FeatureServer/0
  - The script queries it for distinct `LAD26CD, LAD26NM, CTYUA26CD, CTYUA26NM` where `LAD26CD LIKE 'E%'`.
  - For an E07 district, `CTYUA26CD` is its county (E10), which becomes `parent_gss`. For every other LAD, `CTYUA26CD` equals the LAD code.
  - Raw response: `data/raw/ons_lad26_ctyua26_england.json`.
- **Council names and websites** come from the GOV.UK Local Links Manager API: `https://local-links-manager.publishing.service.gov.uk/api/local-authority?authority_slug=<slug>`. This is the data behind `https://www.gov.uk/api/local-authority/<slug>`, but this endpoint also returns `gss`.
  - Slugs are derived from the ONS name. `SLUG_OVERRIDES` covers the exceptions, and each match is checked against the GSS code.
  - `name` holds the council name (for example "Maidstone Borough Council"), not the ONS area name ("Maidstone").
  - Raw responses: `data/raw/govuk_local_authorities.json`.
- Local Links Manager also publishes per-service council URLs with GSS codes, for example LGSL service codes for potholes, fly-tipping and so on: https://local-links-manager.publishing.service.gov.uk/data/links_to_services_provided_by_local_authorities.csv. This will be useful later for `authority_contacts.form_url` and signposting. It is not used yet.

### Police
- **Forces** come from https://data.police.uk/api/forces and `/api/forces/<id>`. Raw responses: `data/raw/police_forces_api.json`.
  - Excluded: `dyfed-powys`, `gwent`, `north-wales`, `south-wales` (Wales) and `northern-ireland` (PSNI).
  - The API does not list British Transport Police, so BTP is not seeded. The script would include it, using the curated URL, if the API ever lists it.
- **`report_url`** is the force website. The API has no online-reporting URL, and its `url` field is missing, empty or `http://` for many forces, so the script uses a curated `WEBSITES` map. Every domain was checked and resolves.
  - Every force except Avon & Somerset is on the national Single Online Home platform. Their ASB form is most likely at `<site>/ro/report/asb/`, but those sites block automated requests (HTTP 403), so this path was not verified and is not used.
- **`non_emergency_url`** is `tel:101` for every force.

## Local government reorganisation (LGR) status as at Sept 2026
- The 2023 changes are already reflected: Cumberland (E06000063), Westmorland and Furness (E06000064), North Yorkshire (E06000065) and Somerset (E06000066). The Cumbria, North Yorkshire and Somerset county/district codes are gone. This leaves 21 counties and 164 districts.
- **Surrey:** the Surrey (Structural Changes) Order 2026 creates East Surrey and West Surrey unitaries. Their shadow councils were elected in May 2026, and **vesting day is 1 April 2027**. Until then Surrey County Council (E10000030) and its 11 districts remain the live authorities, and that is what this seed contains. Before April 2027, regenerate from the 2027 ONS lookup. Expect two new E06 codes, and E10000030 and E07000207–E07000217 to be retired.
- The other LGR areas from the 2024 English Devolution White Paper have no legally confirmed vesting day yet (the House of Commons Library briefing CBP-10494 lists Surrey as the only one). Their changes are expected from 2028, so they don't affect 2026 data.

## Caveats
- **postcodes.io vintage.** The route-report function uses postcodes.io codes, which come from the ONSPD release it was last built on.
  - Spot checks matched this seed: Maidstone E07000110 → Kent E10000016, Guildford → Surrey, Sheffield E08000039, North Yorkshire E06000065, Somerset E06000066, Cumberland E06000063, City of London E09000001. So did about 100 random English postcodes.
  - After a reorganisation, postcodes.io may lag or lead this seed until both are refreshed, so treat an unknown code as "unrouted".
  - When a place has no county, postcodes.io returns `admin_county: null` with code `E99999999`. Non-geographic postcodes return nulls.
- **GOV.UK legacy codes.** GOV.UK still records legacy GSS codes for Barnsley (E08000016, now E08000038), Sheffield (E08000019, now E08000039), North Yorkshire (E10000023, now E06000065) and Somerset (E10000027, now E06000066). The seed always uses the current ONS codes. Keep this in mind when joining the Local Links CSV by GSS.
- Some GOV.UK homepage URLs are `http://`. They are stored as published.

## Council reporting links (`authority_contacts`)

`supabase/seed_contacts.sql` is built by `data/build_contacts.mjs`. It fills `authority_contacts` with one signpost link (`form_url`, `email = null`) per authority and category, taken from GOV.UK Local Links Manager. This replaces "`authority_contacts` is intentionally left empty" above. Hand-entered contacts (email inboxes for the pilot area) can sit alongside these rows.

```sh
node data/build_contacts.mjs             # rebuild from data/raw/ caches
node data/build_contacts.mjs --refresh   # re-download the CSV and re-check every link status
node data/build_contacts.mjs --ok-only   # drop links the GOV.UK checker marks "caution"
```

The script needs `build_authorities.mjs` to have been run first, because it reads `data/raw/ons_lad26_ctyua26_england.json` and `data/raw/govuk_local_authorities.json`.

### Sources
- **Links:** https://local-links-manager.publishing.service.gov.uk/data/links_to_services_provided_by_local_authorities.csv, cached as `data/raw/local_links_services.csv`.
  - Columns: `Authority Name, GSS, Description, LGSL, LGIL, URL, Title, Supported by GOV.UK`. `Description` is `<service>: <interaction>`.
  - It has about 45k rows covering all UK councils. Around 157 rows have an empty URL.
  - The CSV has **no link status column**. It is downloaded with `curl` (retry and resume), because the server often resets the connection part-way through.
- **Link status:** `https://local-links-manager.publishing.service.gov.uk/api/link?authority_slug=<slug>&lgsl=<n>&lgil=<n>` returns `local_interaction.status`, which is one of:
  - `ok`
  - `caution`: the GOV.UK checker got a warning, not an error. Usually the council site answers 403 to bots, or the link redirects.
  - `broken`: an error such as 404 or DNS failure.
  - `missing` or `pending`

  The script only queries the candidate links it would use, which is about 4k calls. Results are cached in `data/raw/local_links_status.json`. The API rate-limits bursts with a 429 or an HTML "too many attempts" page, so the script runs 4 workers and backs off.
- **Filter:** a link is used only if its URL is non-empty, `Supported by GOV.UK = true`, and its status is `ok` or `caution` (`ok` only with `--ok-only`). Anything else is skipped and the next candidate is tried.
- **GSS join:** the CSV uses GOV.UK's GSS codes. The legacy codes (Barnsley E08000016, Sheffield E08000019, North Yorkshire E10000023, Somerset E10000027) are mapped to current codes. The mapping uses the `gss` that GOV.UK returned for each authority in `govuk_local_authorities.json`, with a hard-coded fallback. English codes that aren't in `authorities` are ignored: Poole E06000029, Christchurch E07000048 and Northamptonshire E10000021 are defunct.

### LGSL mapping
LGIL interaction codes: **17** = Reporting, **0** = Applications for service, **8** = Providing information. For each authority and category, the first candidate that passes the filter wins.

| Category | Candidates, in order (LGSL/LGIL) | Notes |
|---|---|---|
| `pothole` | 557 Road maintenance: 17, 0, 8 | |
| `damaged_pavement` | 537 Pavement maintenance: 17, 0, 8; then 557/17, 557/0 | Road maintenance is the fallback |
| `road_markings_signs` | 559 Street furniture: 17, 0, 8; then 557/17, 557/0 | No road markings or signs service exists. 541 Street name plates is info only |
| `street_light` | 564 Street lighting: 17, 0, 8 | |
| `overgrown_vegetation` | 557/17, 557/0 | **No vegetation service** exists, so this is the generic highway fault page |
| `missed_bin` | 524 Household waste collection: 17, 0, 8 | |
| `fly_tipping` | 587 Flytipping: 17, 0, 8 | |
| `overflowing_litter_bin` | 580 Litter removal: 17, 0, 8 | |
| `dog_fouling` | 577 Dog fouling: 17, 0, 8 | |
| `drug_litter` | 428 Syringe disposal: 8; then 580/17, 580/0 | 428 only has an info interaction |
| `graffiti` | 584 Graffiti removal: 17, 0, 8 | |
| `abandoned_vehicle` | 372 Abandoned vehicles: 17, 0, 8 | |
| `noise` | 412 Noise pollution: 17, 0, 8 | |
| `asb` | 870 Community safety: 8 | **No ASB reporting service** exists. This is an info page, and police.uk remains the main ASB route |

Rows are only generated for the tier that `resolve.ts` routes the category to:
- `highway` categories: E10, E06, E08 and E09 (153 authorities)
- all other categories: E06, E07, E08 and E09 (296 authorities)

### Output
- Each row is `(authority_gss, category_group, category_id, email = null, form_url, notes)`. `category_id` and `category_group` are resolved by joining `categories.slug`.
- `notes` looks like `GOV.UK Local Links LGSL 557 LGIL 17 (Road maintenance: Reporting) [caution]`.
- `authority_contacts` has no unique key, so the file first runs `delete ... where notes like 'GOV.UK Local Links%'` and then inserts. It is safe to re-run, and hand-entered rows (any other `notes`) are never touched.
- It joins `authorities`, so unknown codes are silently dropped.
- It is loaded after `seed_police.sql` (see `supabase/config.toml`).

### Coverage (2026-09-26): 2,537 rows across 301 authorities

| Category | ok + caution (default) | ok only |
|---|---|---|
| pothole | 136/153 (89%) | 103 (67%) |
| damaged_pavement | 138/153 (90%): 537=109, 557 fallback=29 | 107 (70%) |
| road_markings_signs | 140/153 (92%): 559=99, 557 fallback=41 | 108 (71%) |
| street_light | 105/153 (69%) | 67 (44%) |
| overgrown_vegetation | 135/153 (88%) | 103 (67%) |
| missed_bin | 243/296 (82%) | 158 (53%) |
| fly_tipping | 252/296 (85%) | 177 (60%) |
| overflowing_litter_bin | 184/296 (62%) | 118 (40%) |
| dog_fouling | 179/296 (60%) | 108 (36%) |
| drug_litter | 185/296 (63%): 428=117, 580 fallback=68 | 120 (41%) |
| graffiti | 185/296 (63%) | 114 (39%) |
| abandoned_vehicle | 220/296 (74%) | 130 (44%) |
| noise | 254/296 (86%) | 166 (56%) |
| asb | 181/296 (61%) | 105 (35%) |

- 2,046 candidate links were rejected as `broken`, about 45% of the links checked. Waste and street-scene links are the worst: roughly 55–60% of the 577, 580 and 584 links are broken.
- When a council has no link for a category, `pickContact` falls back to a group-level or all-category contact, if one exists.

### Caveats
- Many links are stale or generic. The data is maintained by councils and GOV.UK, and a link can be `ok` and still point at a section landing page rather than a form. For example, Manchester fly-tipping resolves to `http://www.manchester.gov.uk/environment`.
- `caution` links look reachable but couldn't be confirmed. A sample of them (Kent, Maidstone, Horsham, Gateshead) answers 403 to automated requests, and one old `nwleics.gov.uk` link redirects to the right page. None of them were checked in a browser. Use `--ok-only` if you would rather have fewer, verified links.
- **Precedence:** `pickContact` in `route-report` prefers a category-specific row (`category_id` set) over a group-level row. If you hand-enter a group-level **email** for a council, delete that council's `GOV.UK Local Links%` rows for the group, or add the email per category. Otherwise these signpost rows will win.
- Re-run with `--refresh` every few months. Link statuses change as councils rebuild their sites.

## Council email inboxes (`seed_contacts_emails.sql`)

`data/council_emails.csv` is a hand-curated list of email addresses that councils publish for street and environment problems. `data/build_emails.mjs` turns it into `supabase/seed_contacts_emails.sql`. Nothing is sent during development (mail is captured locally), but every address is real and sourced.

```sh
node data/build_emails.mjs   # Node 22+, no dependencies; validates the CSV, then writes the SQL
```

### CSV
Columns: `authority_gss,authority_name,scope,email,source_url,confidence,notes,checked_date`.
- `scope` is one of:
  - a category slug, e.g. `noise`
  - `group:<category_group>` (`roads`, `waste`, `street_scene`, `community_safety`)
  - `all`, a catch-all for the council
- `confidence`: `page` (seen on an official council page, or a page of the council's named contractor), `pdf`, or `snippet` (only seen in a search snippet quoting a council page). All current rows are `page`.
- `notes` says what the page publishes the address for. Generic contact-centre addresses start with `GENERIC:` and are only used as `all` fallbacks, or for a category where the page explicitly offers them. Contractor inboxes that a council publishes (Amey, Enerveo, Veolia, Glendale) start with `CONTRACTOR:`.
- Use current ONS GSS codes, not GOV.UK's legacy ones. For example Barnsley is `E08000038` and Sheffield is `E08000039`. Unknown codes drop out when the SQL joins `authorities`.

### Rules used when collecting (2026-09-26)
- Only addresses printed on an official council page (or a contractor page the council links to). The exact URL is recorded for each one. No guessed patterns: if a council didn't print a `highways@` address, it isn't here.
- Service-specific inboxes are preferred over contact centres.
- Personal staff addresses, councillor addresses, and inboxes for other purposes are left out, as are anything a page says not to use. Examples of other-purpose inboxes: FOI, licensing, planning, CCTV, the 24/7 emergency control room, and scheme consultation mailboxes.
- Many councils publish no report inboxes at all and use forms only. These keep their GOV.UK or verified form links. Checked and found to have none: Wigan, Bury, Birmingham, Liverpool, Bristol, Kent CC, Maidstone (403 to automated fetches), Camden, Plymouth, Hull, Dorset, Buckinghamshire, both Northamptonshire unitaries, Cumberland, Wiltshire, Doncaster, Gateshead, South Tyneside and Sunderland.
- Manchester publishes only `asb.action.team@` (ASB, for private tenants) and the Neighbourhood Services address `contact@` (generic). Highways, lighting, waste and cleansing reports go through its Verint forms (see `seed_contacts_verified.sql`). Street-light faults are passed electronically to the PFI contractor Amey, which has no public inbox.
- Sites whose robots.txt blocks Claude or AI agents were not crawled (Darlington; Stockport was only spot-checked). Wigan's `/Contacts/` pages are disallowed for all agents and were not fetched.

### SQL output
- The file first runs `delete ... where notes like 'Email:%'`, so it is safe to re-run and never touches other contact rows.
- Every row gets `priority 200`, above verified form links (100) and GOV.UK Local Links (0). `notes` is `Email: <confidence> · <source_url>`.
- **Group scopes are expanded into one row per category** in the group, skipping any category that has its own CSV row for that council. This is needed because `pickContact` prefers any category-specific row over a group row, whatever the priority, so a group-level email row would never beat the per-category Local Links signposts.
- `all` rows have `category_id` and `category_group` null. They only win for a category that has no category-specific row for that council, so in practice they rarely apply.

### Coverage (2026-09-26)
- 170 CSV rows: 152 distinct addresses across 68 councils (`category` 108, `group` 41, `all` 21).
- After group expansion, the SQL inserts 268 rows.
- Greater Manchester:
  - Bolton, Oldham, Rochdale, Salford, Stockport and Trafford have service inboxes.
  - Manchester has an ASB inbox plus a generic address.
  - Tameside has a generic address only.
  - Wigan and Bury have none.
- Re-check the addresses every few months. Councils rename inboxes when they rebuild their sites.
