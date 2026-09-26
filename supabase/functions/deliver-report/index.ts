// Edge Function: deliver-report
// POST { "report_id": "<uuid>", "force"?: boolean }
// Sends a routed report's pending/failed email deliveries to the council, marks signpost
// deliveries 'needs_user', and updates the report status + timeline. Called by route-report
// after routing; safe to call again (retries only 'pending' / 'failed' deliveries).
// See docs/PLAN.md §5 "Delivery" and README.md.

import { createClient } from "npm:@supabase/supabase-js@2";
import { createEmailSenderFromEnv, emailModeFromEnv, type EmailSender } from "../_shared/email/mod.ts";
import { DEFAULT_REPLY_DOMAIN, defaultEmailFrom, type DeliverDeps } from "./deliver.ts";
import { createHandler } from "./handler.ts";
import { SupabaseDeliveryRepo } from "./repo.ts";

let deps: DeliverDeps | null = null;
let sender: EmailSender | null = null;

function getDeps(): DeliverDeps {
  if (deps) return deps;
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  const db = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const replyDomain = Deno.env.get("REPLY_DOMAIN")?.trim() || DEFAULT_REPLY_DOMAIN;
  deps = {
    repo: new SupabaseDeliveryRepo(db),
    email: () => (sender ??= createEmailSenderFromEnv()),
    config: {
      emailFrom: Deno.env.get("EMAIL_FROM")?.trim() || defaultEmailFrom(replyDomain),
      replyDomain,
      emailMode: emailModeFromEnv(),
    },
  };
  return deps;
}

Deno.serve(createHandler(getDeps));
