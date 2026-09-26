# classify-photo

Suggests a report category for a photo (PLAN.md §7). It uses Claude Haiku 4.5 first. If the top confidence is below 0.6, or the output is malformed, it retries once with Claude Sonnet 5. The AI only suggests a category; the user makes the final choice.

Files:
- `index.ts`: `Deno.serve` entry point. It wires up the env vars and Supabase Storage.
- `handler.ts`: the HTTP handler (CORS, auth check, validation). It is testable because its dependencies are injected.
- `../_shared/ai/categories.ts`: category slugs and a visual description of each one.
- `../_shared/ai/classify.ts`: the Anthropic Messages API call over plain fetch, plus retries, fallback and output normalisation.

## Environment

| Var | Required | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | Production: `supabase secrets set ANTHROPIC_API_KEY=sk-ant-...`. Local: add it to `supabase/functions/.env` and run `supabase functions serve --env-file supabase/functions/.env`. |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | auto | Injected by Supabase. Used only for `storage_path` downloads from the `report-photos` bucket. |
| `CLASSIFY_MODEL` | no | Overrides the primary model (default `claude-sonnet-5`). |
| `CLASSIFY_FALLBACK_MODEL` | no | Optional model to retry with when confidence is low (default: none). |
| `CLASSIFY_ALLOWED_ORIGINS` | no | A comma-separated CORS allow-list. The default is `*`, which is fine because auth uses a bearer header rather than cookies. |

Keep `verify_jwt` enabled (the default) for this function. The gateway rejects invalid JWTs. The handler itself only checks that a `Authorization: Bearer …` header is present, and an anonymous sign-in counts. The per-user rate limit is still a TODO in `handler.ts`.

## Request

`POST /functions/v1/classify-photo` with the headers `Authorization: Bearer <supabase access token>` and `Content-Type: application/json`.

Send either the image inline:

```json
{ "image_base64": "/9j/4AAQ…", "media_type": "image/jpeg", "context_hint": "on a road" }
```

or a photo that is already uploaded:

```json
{ "storage_path": "<user-id>/<report-id>/photo.jpg", "context_hint": "in a park" }
```

- Allowed types are `image/jpeg`, `image/png` and `image/webp`. The actual type is detected from the file's magic bytes, and a `data:` URL prefix is accepted.
- The decoded image can be at most 5 MB. Resize on the device first: a long edge of about 1568 px is the most the model uses, and anything larger only costs upload time.
- `context_hint` is optional (max 500 characters are used). It matters most for `noise`, `asb` and `missed_bin`, which rarely show clearly in a photo.

## Response

`200`:

```json
{
  "ok": true,
  "result": {
    "candidates": [
      { "category": "pothole", "confidence": 0.91 },
      { "category": "damaged_pavement", "confidence": 0.06 },
      { "category": "road_markings_signs", "confidence": 0.02 }
    ],
    "description": "Large pothole in the nearside lane with standing water.",
    "severity": "high",
    "contains_people": false,
    "contains_plates": false,
    "unsafe_or_irrelevant": false,
    "reason": "Clear crater in the tarmac road surface."
  },
  "model": "claude-sonnet-5",
  "usage": { "input_tokens": 3100, "output_tokens": 180 },
  "fallback_used": false
}
```

Guarantees about `result`:
- `candidates` has 1 to 3 entries, sorted by confidence (descending), each clamped to 0–1.
- Only known slugs appear. If nothing valid comes back, you get `[{ "category": "other", "confidence": 0 }]`.
- `description` is at most 280 characters.
- If the model omits `contains_people` or `contains_plates`, they default to `true`. This errs on the private side, so the photo waits for moderation.

Category slugs: `pothole`, `damaged_pavement`, `road_markings_signs`, `street_light`, `overgrown_vegetation`, `missed_bin`, `fly_tipping`, `overflowing_litter_bin`, `dog_fouling`, `drug_litter`, `graffiti`, `abandoned_vehicle`, `noise`, `asb`, `other`.

Errors return `{ "ok": false, "error": { "code": "...", "message": "..." } }`:

| Status | code | Meaning |
|---|---|---|
| 400 | `invalid_input` | Bad JSON, bad base64, or a missing field |
| 401 | `unauthorized` | No bearer token |
| 404 | `not_found` | The `storage_path` could not be downloaded |
| 405 | `method_not_allowed` | The method was not POST or OPTIONS |
| 413 | `payload_too_large` | The image is over 5 MB |
| 415 | `unsupported_media_type` | The image is not JPEG, PNG or WebP |
| 422 | `refused` | The model declined the image. Send the report to moderation. |
| 500 | `config` | `ANTHROPIC_API_KEY` is not set |
| 502 | `api_error` / `network` / `invalid_output` | Upstream failure |
| 503 | `rate_limited` / `overloaded` | 429 or 529 still failing after 2 retries |
| 504 | `timeout` | No response within 30 s |

For any 5xx, the app should fall back to manual category selection.

## Cost (rough)

Per image with Haiku 4.5 ($1 / $5 per million input/output tokens):
- Input is about 1.6k image tokens plus about 1.5k tokens of system prompt and tool definition, so roughly 3.1k tokens, or about $0.003.
- Output is about 150–250 tokens, or about $0.001.

That comes to **about $0.004 (about £0.003) per photo**. When the Sonnet 5 fallback runs ($2 / $10), it adds about $0.009, so a low-confidence photo costs about $0.013 in total. Retries after a 429 or 529 are not billed.

## Tests

```sh
cd supabase/functions/classify-photo
deno task test    # mocked fetch; the real API is never called
deno task check
```
