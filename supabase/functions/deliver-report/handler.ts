// HTTP layer for deliver-report: request parsing and outcome -> status code mapping.

import { type DeliverDeps, deliverReport } from "./deliver.ts";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });
}

export function createHandler(getDeps: () => DeliverDeps) {
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
    if (typeof reportId !== "string" || reportId.trim() === "") {
      return json({ error: "report_id is required" }, 400);
    }

    try {
      const outcome = await deliverReport(reportId.trim(), getDeps(), { force: b.force === true });
      switch (outcome.kind) {
        case "not_found":
          return json({ error: `${outcome.what}_not_found`, report_id: outcome.reportId }, 404);
        case "skipped":
          return json(
            { status: "skipped", report_id: outcome.reportId, reason: outcome.reason },
            409,
          );
        case "processed":
          return json({
            status: "processed",
            report_id: outcome.reportId,
            report_status: outcome.reportStatus,
            sent: outcome.sent,
            failed: outcome.failed,
            deliveries: outcome.deliveries,
            needs_user: outcome.needsUser,
            held_for_moderation: outcome.heldForModeration,
          });
      }
    } catch (err) {
      console.error("deliver-report failed", err);
      return json({ error: "internal_error" }, 500);
    }
  };
}
