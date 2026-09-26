# Report

A prototype app for reporting local problems in England, such as potholes, missed bins, fly-tipping, graffiti and anti-social behaviour. You take a photo and it works out what the problem is, who is responsible (the council or the police), and gets the report to them. You can then track it until it's fixed.

**Site:** https://alexgitta.github.io/report/

> Prototype. It isn't a live service and no reports reach real councils: all email is captured locally.

## What it does
- **Photo first.** Claude (Sonnet) looks at the photo and suggests the category and a description. You confirm or change it.
- **Location.** It uses the GPS in the photo when there is any, otherwise your current location, and you can adjust the pin on the map.
- **Routing.** It works out the responsible authority from ONS boundaries and the council structure. In two-tier areas the county handles highways and the district handles bins; unitary, metropolitan and London councils handle both. It also finds the police force from police.uk.
- **Delivery.** It emails the council when it has a published address (152 addresses across 68 councils). Otherwise it sends you to the council's own online form, with your report ready to paste in. Manchester and Greater Manchester Police have verified links straight to their forms.
- **Anti-social behaviour.** You get 999/101 prompts first, then the report goes to the council's ASB team with a link to the police force's ASB form.
- **Tracking.** A timeline, "still there" and "fixed" updates from neighbours, and the council's reference number.

## Stack
- **App:** Expo (React Native and TypeScript, expo-router) for iOS, Android and web. Maps use react-native-maps, or Leaflet with OpenStreetMap on web.
- **Backend:** Supabase: Postgres and PostGIS, auth (including anonymous sign-in), storage, and edge functions in Deno (`classify-photo`, `route-report`, `deliver-report`).
- **Data:** the ONS local authority lookup, GOV.UK Local Links, data.police.uk and postcodes.io.

## Repository
| Path | What's there |
|---|---|
| `mobile/` | Expo app |
| `supabase/` | Migrations, seed data and edge functions |
| `data/` | Scripts and raw sources behind the council, police and contact seed data |
| `docs/PLAN.md` | Product and technical plan |
| `docs/RUNNING.md` | How to run it locally |
| `site/` | The GitHub Pages site |

## Running it
See [docs/RUNNING.md](docs/RUNNING.md). In short: `supabase start`, then `cd mobile && npx expo start`. AI photo detection needs `ANTHROPIC_API_KEY` in `supabase/functions/.env`, which is git-ignored.
