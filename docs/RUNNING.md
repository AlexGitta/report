# Running the app locally

Two parts: the **backend** (Supabase in Docker) and the **app** (Expo). Run each in its own PowerShell window.

## One-time setup (already done on this laptop)
- Node 22, Docker Desktop
- Supabase CLI at `%LOCALAPPDATA%\supabase-cli\supabase.exe` (on your user PATH, so `supabase` works in a new terminal)
- `mobile\.env.local`: the local Supabase publishable key
- `supabase\functions\.env`: `ANTHROPIC_API_KEY` for AI photo detection
- Expo CLI logged in (`npx expo whoami`)

## 1. Backend
Start **Docker Desktop** first and wait until it says "Engine running". Then:

```powershell
cd C:\Users\notal\report
supabase start
```

This takes about 30 s when the images are already downloaded. Useful pages:
- Studio (browse the database): http://127.0.0.1:54323
- Mailpit (emails the app "sent"): http://127.0.0.1:54324

## 2. App
```powershell
cd C:\Users\notal\report\mobile
npx expo start
```

Then:
- **Browser:** press `w`, or open http://127.0.0.1:8081. Press F12, then Ctrl+Shift+M for the phone view. Use 127.0.0.1, not localhost; an old service worker is registered on localhost.
- **Phone:** scan the QR code with Expo Go, signed in as the same Expo account. The phone must be on the same network as the laptop. Guest Wi-Fi usually blocks this, but a phone hotspot works.
- Press `r` to reload, and Ctrl+C to stop.

## Stopping
- App: Ctrl+C in its window.
- Backend: `supabase stop`. Your data is kept. `supabase stop --no-backup` wipes it.

## Common tasks
| Task | Command (from `C:\Users\notal\report`) |
|---|---|
| Rebuild the database from migrations + seeds (wipes test reports) | `supabase db reset` |
| Changed `supabase\functions\.env` | `supabase stop` then `supabase start` |
| Run the edge function tests | `cd supabase\functions\route-report; ~\.deno\bin\deno.exe test --allow-env ..\_shared\routing\ .` (same pattern for `deliver-report` and `classify-photo`) |
| Typecheck the app | `cd mobile; npx tsc --noEmit` |

## Troubleshooting
- **"Welcome to Expo" in the browser:** you're on localhost, where an old service worker lives. Use http://127.0.0.1:8081.
- **Phone can't connect:** the laptop and phone aren't on the same network, or the network isolates devices.
- **"You need to be signed in" in Expo Go:** sign in to the same account on the phone and with `npx expo login` on the laptop.
- **Categories or reports fail to load:** the backend isn't running. Check `supabase status`.
- **AI says "choose a category manually":** `ANTHROPIC_API_KEY` is missing, or you changed `.env` without restarting Supabase.
