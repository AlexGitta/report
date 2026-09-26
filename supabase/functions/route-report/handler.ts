// HTTP layer for route-report: request parsing and outcome -> status code mapping.

import { GeoLookupError } from "../_shared/routing/geo.ts";
import { type RouteDeps, routeReport } from "./route.ts";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS, ...extra },
  });
}

/**
 * Runs the delivery step for a freshly routed report and returns its JSON result (included in
 * the route-report response as `delivery`). Errors are caught by the handler.
 */
export type TriggerDelivery = (reportId: string) => Promise<unknown>;

export interface HandlerOptions {
  /** Default: POST to the deliver-report Edge Function (see deliverViaFunction). null = off. */
  triggerDelivery?: TriggerDelivery | null;
}

/**
 * Calls the deliver-report Edge Function with the service-role key. Skipped (no request) when
 * SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are missing or AUTO_DELIVER=false.
 */
export async function deliverViaFunction(
  reportId: string,
  env: (name: string) => string | undefined = (n) => Deno.env.get(n),
  fetchFn: typeof fetch = fetch,
): Promise<unknown> {
  const url = env("SUPABASE_URL");
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  if (env("AUTO_DELIVER") === "false") {
    return { status: "not_triggered", reason: "AUTO_DELIVER=false" };
  }
  if (!url || !key) return { status: "not_triggered", reason: "delivery not configured" };
  const res = await fetchFn(`${url.replace(/\/+$/, "")}/functions/v1/deliver-report`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, apikey: key, "content-type": "application/json" },
    body: JSON.stringify({ report_id: reportId }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch { /* keep text */ }
  if (!res.ok && res.status !== 409) {
    return { status: "error", http_status: res.status, body: data };
  }
  return data;
}

export function createHandler(getDeps: () => RouteDeps, opts: HandlerOptions = {}) {
  const triggerDelivery = opts.triggerDelivery === undefined
    ? deliverViaFunction
    : opts.triggerDelivery;
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ error: "invalid_json" }, 400);
    }
    const b = (body ?? {}) as Record<string, unknown>;
    const reportId = b.report_id;
    if (
      (typeof reportId !== "string" || reportId.trim() === "") && typeof reportId !== "number"
    ) {
      return json({ error: "report_id is required" }, 400);
    }

    try {
      const outcome = await routeReport(String(reportId), getDeps(), { force: b.force === true });
      switch (outcome.kind) {
        case "not_found":
          return json({ error: `${outcome.what}_not_found`, report_id: outcome.reportId }, 404);
        case "skipped":
          return json({ status: "skipped", report_id: outcome.reportId, reason: outcome.reason }, 409);
        case "unrouted":
          return json({
            status: "unrouted",
            report_id: outcome.reportId,
            reason: outcome.reason,
            message: outcome.message,
            warnings: outcome.warnings,
          });
        case "routed": {
          // Routing is saved; a delivery failure must not turn this into an error response
          // (deliver-report can be re-run: it retries 'pending' / 'failed' deliveries).
          let delivery: unknown = undefined;
          if (triggerDelivery) {
            try {
              delivery = await triggerDelivery(outcome.reportId);
            } catch (err) {
              console.error("route-report: delivery trigger failed", err);
              delivery = { status: "error", message: (err as Error)?.message ?? String(err) };
            }
          }
          return json({
            status: "routed",
            report_id: outcome.reportId,
            routed_authorities: outcome.routedAuthorities,
            police: outcome.police,
            deliveries: outcome.deliveries,
            warnings: outcome.warnings,
            delivery,
          });
        }
      }
    } catch (err) {
      if (err instanceof GeoLookupError) {
        console.error("route-report lookup failed", err.message);
        return json(
          { error: "lookup_failed", service: err.service, kind: err.kind, retryable: err.retryable },
          err.retryable ? 503 : 502,
          err.retryable ? { "retry-after": "60" } : {},
        );
      }
      console.error("route-report failed", err);
      return json({ error: "internal_error" }, 500);
    }
  };
}
