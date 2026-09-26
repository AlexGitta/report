# Local Problem Reporter — v1 Plan

An independent citizen app for England. People report local problems (potholes, missed bins, graffiti, ASB, etc.) with a photo and a location. The app works out which council and police force is responsible, sends the report to them, and lets people follow it until it's resolved.

Status: **draft for review**. Nothing is built yet.

---

## 1. Decisions so far

| Area | Decision |
|---|---|
| Model | Independent citizen app. We forward reports; authorities don't need to sign up |
| Coverage | England only |
| App | Expo (React Native + TypeScript, expo-router). Preview on phone via Expo Go, plus a web build |
| Backend | Supabase: local via Docker during development, hosted later |
| Accounts | Optional. Report anonymously, or sign in to track reports and get notifications |
| ASB | Signpost to 999/101 and police.uk, send to the council ASB team, show on the public map without personal details |
| AI | Hosted vision LLM (Claude) suggests the category; the user confirms |
| Build | From scratch. FixMyStreet's ideas and Open311 as reference, not its code |

## 2. Stack

- **Mobile/web app:** Expo SDK (latest), TypeScript, expo-router
  - `react-native-maps` (OpenStreetMap tiles on web via `react-leaflet` fallback)
  - `expo-location`, `expo-camera` / `expo-image-picker`, `expo-image-manipulator` (resize before upload)
  - `expo-notifications`
  - `@supabase/supabase-js`, TanStack Query
- **Backend:** Supabase
  - Postgres + PostGIS
  - Auth: email magic link + Google/Apple, anonymous sign-in for guests
  - Storage for photos
  - Realtime for live status updates
  - Edge Functions (Deno) for routing, AI and delivery
- **Local dev:** `npx supabase start` (Docker). Local Studio and a mail catcher (Mailpit) for testing outgoing emails
- **Email delivery (hosted):** Resend or Postmark
- **AI:** Claude Haiku 4.5 by default (cheap, fast); retry on Claude Sonnet 5 when confidence is low

## 3. Categories (v1)

Every category has a `routing_target` (see §5) and a `public` visibility flag.

| Group | Category | Routes to |
|---|---|---|
| **Roads & pavements** | Pothole | Highway authority |
| | Damaged pavement | Highway authority |
| | Road markings / signs | Highway authority |
| **Waste** | Missed bin collection | Waste collection authority |
| | Fly-tipping | Waste collection authority |
| | Overflowing litter bin | Waste collection authority |
| | Dog fouling | Waste collection authority |
| **Street scene** | Graffiti | Waste collection authority (district/unitary) |
| | Broken street light | Highway authority |
| | Abandoned vehicle | District/unitary council |
| | Overgrown vegetation | Highway authority |
| **ASB / community safety** | Anti-social behaviour | Council ASB team + police signpost |
| | Noise nuisance | District/unitary council (environmental health) |
| | Drug litter / needles | Waste collection authority (urgent flag) |

"Missed bin collection" is really about a specific address, not a map point. It should ask for the address and point people to their council's own missed-bin form where there is one.

## 4. Report flow (user)

1. **Photo:** take one or pick from the gallery (up to 3). Resized on the device to about 1600px.
2. **Location:** GPS pin, which the user can drag. Falls back to reading the photo's EXIF location, then to a postcode/address search.
3. **Category:** AI suggests the top 3 with confidence and pre-selects the best one when confidence is ≥ 0.8. The user can always change it.
4. **Details:** AI drafts a short description, which the user edits. There are extra fields for some categories (e.g. bin type, vehicle registration).
5. **Safety interstitial** (ASB, drug litter): "If anyone is in danger, call 999. Non-emergency: 101."
6. **Duplicate check:** if there's an open report in the same category within 25 m, show it. The user can back it ("+1 / still there") instead of making a new report.
7. **Contact:** optional sign-in. Guests can give an email for updates, and name/phone if the council needs them.
8. **Submit:** a confirmation screen shows who it's going to (e.g. "Kent County Council — Highways").

## 5. Routing engine (England)

### Authority tiers
England has different local government structures, and GSS code prefixes tell us which one a council is:

| GSS prefix | Type | Highways | Waste collection |
|---|---|---|---|
| E06 | Unitary authority | itself | itself |
| E07 | Non-metropolitan district | the county (E10) | itself |
| E08 | Metropolitan district | itself | itself |
| E09 | London borough | itself (TfL for red routes) | itself |
| E10 | County council | itself | the districts |

`routing_target` values: `highway`, `waste_collection`, `district_or_unitary`, `asb`, `police_signpost`.

### Lookup pipeline (Edge Function `route-report`)
1. **Point → councils**
   - v1: postcodes.io reverse geocode (`/postcodes?lon=&lat=`) gives `admin_district` and `admin_county` plus their GSS codes. It's free and has no key.
   - v1.1: load ONS Local Authority District and County boundaries into PostGIS and use `ST_Contains`. No external calls, and it works away from postcodes (parks, rural areas).
2. **Point → police**: `data.police.uk/api/locate-neighbourhood?q=lat,lng` gives the force and neighbourhood. We store the force's online reporting URL from our `police_forces` table.
3. **Resolve** by applying the tier table to the category's `routing_target`, which gives the destination authorities. The destination is snapshotted on the report.
4. **Edge cases**
   - Motorways and trunk roads belong to National Highways. Detect them from OSM road classification (v1.1); in v1 show a notice.
   - Red routes in London belong to TfL.
   - Private land and housing association estates can't be resolved. Mark them "unrouted" and send them to the moderation queue.

### Delivery (Edge Function `deliver-report`)
- **Email** to `authority_contacts.email` for that authority and category group. The email includes the photo(s), a map link, the location, description and our reference, plus a reply-to address that feeds back into our system later.
- **Signpost** when we have no email, or when the council requires its own form. The report is marked "Needs you to submit" and gets a deep link to the council page (from the GOV.UK Local Links data) or the police.uk force page. The user copies our pre-filled text across.
- **Open311** later, for councils that support it.
- **Contacts data** is the main ongoing effort. There's no public dataset of council inbox addresses. v1 plan: seed one pilot area by hand, use signposting everywhere else, and add councils over time.

## 6. Tracking

Report statuses:

```
draft → submitted → sent → acknowledged → in_progress → fixed | closed | unrouted
```

- **Timeline** (`report_updates`): every status change and comment, with who made it (system, reporter, public, moderator).
- **Signals from people:** the reporter can mark it fixed. Anyone can say "still there" or "fixed", with an optional photo. If there are no updates after 28 days, ask the reporter.
- **Council replies:** v1 means a moderator enters them by hand. Later, parse inbound email replies sent to `reply+<ref>@…`.
- **Notifications:** push (Expo) plus email, for changes on your own or followed reports.
- **Public report page:** map, photo, status and timeline. The reporter's name is hidden by default.

## 7. AI categorisation (Edge Function `classify-photo`)

- **Input:** the resized image, and optionally the location context (e.g. "on a road" vs "in a park").
- **Prompt:** the category list with descriptions. The model must return JSON via tool use:
  ```json
  { "candidates": [{"category": "pothole", "confidence": 0.92}],
    "description": "Large pothole in nearside lane…",
    "severity": "low|medium|high",
    "contains_people": true, "contains_plates": false,
    "unsafe_or_irrelevant": false }
  ```
- **Behaviour:**
  - AI only suggests; the user decides.
  - If the photo is flagged unsafe or irrelevant, the report goes to moderation.
  - Store the AI output and the user's final choice, so we can measure accuracy per category.
- **Privacy:**
  - Strip EXIF (after reading the location) before storing.
  - v1: photos with `contains_people` or `contains_plates` stay private until a moderator approves them.
  - v1.1: automatic face and number-plate blurring, using a small detector in a separate service.
- **Cost:** about £0.001–0.005 per photo on Haiku. Rate-limited per device and user.

## 8. Data model (Postgres)

```
profiles          id (auth.users), display_name, email, phone, is_moderator
categories        id, slug, group, name, description, routing_target, public, urgent, extra_fields jsonb
authorities       gss_code PK, name, type (E06..E10), parent_gss, website
authority_contacts id, authority_gss, category_group, email, form_url, notes
police_forces     id (police.uk slug), name, report_url, non_emergency_url
reports           id, ref (short public code), category_id, status, location geography(Point,4326),
                  address_text, description, severity, reporter_id null, guest_email null,
                  is_anonymous_public, ai_result jsonb, duplicate_of null,
                  routed_authorities text[], police_force_id, police_neighbourhood,
                  created_at, updated_at
report_photos     id, report_id, storage_path, width, height, is_public
report_updates    id, report_id, actor_type, actor_id, kind (status|comment|still_there|fixed), 
                  status_to, body, photo_path, created_at
deliveries        id, report_id, authority_gss | police_force_id, channel (email|signpost|open311),
                  status, provider_message_id, sent_at, error
report_followers  report_id, user_id
```

- **Indexes:** GIST on `reports.location`, plus `(status, category_id)`.
- **Row-level security:**
  - Public can read public reports and public photos only.
  - Owners can read and update their own reports.
  - Moderators have full access.
  - Writes go through RPCs or edge functions.
- **Nearby query:** an RPC `reports_near(lat, lng, radius_m)` using `ST_DWithin`.

## 9. Screens

1. **Map (home):** reports near me, category filter chips, "Report a problem" button.
2. **Report wizard:** photo → location → category → details → review.
3. **Report detail:** photo, status, timeline, "still there / fixed", follow.
4. **My reports:** list with status badges.
5. **Account:** sign in, notification settings.
6. **Moderation** (web, moderators only): unrouted, flagged and private-photo queues, and manual status updates.

## 10. Milestones

| # | Milestone | Done when |
|---|---|---|
| M0 | Scaffold | Expo app runs in Expo Go and on the web; `supabase start` works; schema migrations and category seed data exist |
| M1 | Report flow | Photo, GPS pin and manual category make a report with its photo in local Supabase |
| M2 | Map + tracking | Nearby reports on the map, report detail with timeline, My reports, community updates |
| M3 | Routing | postcodes.io + police.uk lookup, tier resolution, email delivery to Mailpit locally, signpost fallback |
| M4 | AI | `classify-photo` suggests categories and a description; accuracy logging |
| M5 | Accounts + notifications | Optional sign-in, guest email tracking, push notifications |
| M6 | Safety + moderation | ASB interstitial, private-photo handling, moderation web view, rate limits |
| M7 | Pilot | Hosted Supabase, one pilot council area's contacts seeded, EAS builds to TestFlight / Play internal testing |

## 11. Risks / open questions

- **Council contact data:** who maintains it, and should we pick a pilot area? *(Needs a decision.)*
- **Legal/GDPR:**
  - privacy notice
  - lawful basis for sending personal data to councils
  - retention period for photos and reports
  - ICO registration (fee applies)
- **Liability wording:** it has to be clear that we're not the council and that emergencies go to 999.
- **Abuse:** false or malicious ASB reports naming people. Mitigate with moderation, no free-text naming of individuals, and no public addresses for ASB.
- **Council reception:** some councils may treat third-party emails as lower priority. Signposting their own forms reduces friction.
- **Name/brand:** TBD.
