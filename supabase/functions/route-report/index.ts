// Edge Function: route-report
// POST { "report_id": "<uuid>", "force"?: boolean }
// Works out which council(s) and police force a report goes to, snapshots that onto the report
// and queues `deliveries` rows (email / signpost) for the deliver-report step.
// See docs/PLAN.md §5.

import { createClient } from "npm:@supabase/supabase-js@2";
import { lookupCouncils, lookupPolice } from "../_shared/routing/geo.ts";
import { createHandler } from "./handler.ts";
import { SupabaseRoutingRepo } from "./repo.ts";
import type { RouteDeps } from "./route.ts";

let deps: RouteDeps | null = null;

function getDeps(): RouteDeps {
  if (deps) return deps;
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  const db = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  deps = {
    repo: new SupabaseRoutingRepo(db),
    lookupCouncils: (lat, lng) => lookupCouncils(lat, lng),
    lookupPolice: (lat, lng) => lookupPolice(lat, lng),
  };
  return deps;
}

Deno.serve(createHandler(getDeps));
