// Core of the route-report Edge Function (PLAN §5 "Lookup pipeline"). No HTTP, no env:
// all I/O comes in through RouteDeps so it can be tested with fakes.

import {
  type CouncilLookupResult,
  GeoLookupError,
  type PoliceLookupResult,
} from "../_shared/routing/geo.ts";
import {
  type DestinationRole,
  resolveDestinations,
  type RoutingWarning,
} from "../_shared/routing/resolve.ts";
import { authorityTypeFromGss, isRoutingTarget } from "../_shared/routing/types.ts";
import { parsePoint } from "./location.ts";
import type {
  AuthorityRow,
  ContactRow,
  NewDelivery,
  PoliceForceRow,
  RoutingRepo,
} from "./repo.ts";

export interface RouteDeps {
  repo: RoutingRepo;
  lookupCouncils: (lat: number, lng: number) => Promise<CouncilLookupResult | null>;
  lookupPolice: (lat: number, lng: number) => Promise<PoliceLookupResult | null>;
}

export interface RouteOptions {
  /** Re-route even if the report has moved past 'submitted' / 'unrouted'. */
  force?: boolean;
}

/** Statuses from which (re-)routing is allowed without `force`. */
export const ROUTABLE_STATUSES = ["submitted", "unrouted"];

/** Fallback signpost for police when police_forces has no report_url. */
export const POLICE_UK_URL = "https://www.police.uk/";

export interface PlannedDelivery {
  authorityGss: string | null;
  policeForceId: string | null;
  role: DestinationRole | "police_signpost";
  channel: "email" | "signpost";
  /** Email address (email) or URL the user should submit on (signpost; null if unknown). */
  recipient: string | null;
}

export type RouteOutcome =
  | {
    kind: "routed";
    reportId: string;
    routedAuthorities: string[];
    police: PoliceLookupResult | null;
    deliveries: PlannedDelivery[];
    warnings: RoutingWarning[];
  }
  | {
    kind: "unrouted";
    reportId: string;
    reason: string;
    message: string;
    warnings: RoutingWarning[];
  }
  | { kind: "not_found"; reportId: string; what: "report" | "category" }
  | { kind: "skipped"; reportId: string; reason: string };

const UNROUTED_MESSAGES: Record<string, string> = {
  no_location: "The report has no usable location.",
  invalid_location: "The report location is not valid.",
  no_council: "No council could be found for this location.",
  no_district: "No council could be found for this location.",
  outside_england: "This location is outside England.",
  missing_county: "The county council for this area could not be identified.",
  unsupported_authority_type: "The council type for this location is not supported.",
  bad_routing_target: "The report's category has no valid routing target.",
  no_police_force: "No police force could be found for this location.",
};

/** Missed bins are about an address; if the council has its own form, send people there. */
const PREFER_FORM_SLUGS = new Set(["missed_bin"]);

export async function routeReport(
  reportId: string,
  deps: RouteDeps,
  opts: RouteOptions = {},
): Promise<RouteOutcome> {
  const { repo } = deps;
  const report = await repo.getReport(reportId);
  if (!report) return { kind: "not_found", reportId, what: "report" };
  if (!opts.force && !ROUTABLE_STATUSES.includes(report.status)) {
    return { kind: "skipped", reportId, reason: `status is '${report.status}'` };
  }
  const category = await repo.getCategory(report.category_id);
  if (!category) return { kind: "not_found", reportId, what: "category" };

  const warnings: RoutingWarning[] = [];
  let police: PoliceLookupResult | null = null;

  const unrouted = async (reason: string): Promise<RouteOutcome> => {
    const message = UNROUTED_MESSAGES[reason] ?? "This report could not be routed automatically.";
    await repo.markUnrouted({
      reportId,
      reason,
      message,
      policeForceId: police ? (await knownForce(repo, police.force))?.id ?? null : null,
      policeNeighbourhood: police?.neighbourhood ?? null,
    });
    return { kind: "unrouted", reportId, reason, message, warnings };
  };

  const target = category.routing_target;
  if (!isRoutingTarget(target)) return await unrouted("bad_routing_target");

  const point = parsePoint(report.location);
  if (!point) return await unrouted("no_location");

  const needsPolice = target === "asb" || target === "police_signpost";

  // Lookups in parallel. Council failures always propagate (retryable); police failures only
  // matter when the category needs the police.
  let councils: CouncilLookupResult | null;
  try {
    const [c, p] = await Promise.all([
      deps.lookupCouncils(point.lat, point.lng),
      deps.lookupPolice(point.lat, point.lng).catch((err) => {
        if (needsPolice || !(err instanceof GeoLookupError)) throw err;
        console.warn("route-report: police lookup failed, continuing", err.message);
        return null;
      }),
    ]);
    councils = c;
    police = p;
  } catch (err) {
    if (err instanceof GeoLookupError && err.kind === "invalid_input") {
      return await unrouted("invalid_location");
    }
    throw err;
  }

  if (!councils && target !== "police_signpost") return await unrouted("no_council");

  // Two-tier district without a county from postcodes.io: fall back to authorities.parent_gss.
  let countyGss = councils?.county?.gss ?? null;
  const districtGss = councils?.district.gss ?? null;
  if (districtGss && !countyGss && authorityTypeFromGss(districtGss) === "E07") {
    const [row] = await repo.getAuthorities([districtGss]);
    if (row?.parent_gss) countyGss = row.parent_gss;
  }

  const resolved = resolveDestinations({
    routingTarget: target,
    district: districtGss ? { gss: districtGss } : null,
    county: countyGss ? { gss: countyGss } : null,
  });
  warnings.push(...resolved.warnings);
  if (resolved.unrouted) return await unrouted(resolved.unroutedReason ?? "no_council");
  if (resolved.policeSignpost && !police) return await unrouted("no_police_force");

  // Make sure every destination authority exists (FK target for deliveries).
  const destGss = [...new Set(resolved.destinations.map((d) => d.authorityGss))];
  const known = new Map((await repo.getAuthorities(destGss)).map((a) => [a.gss_code, a]));
  const missing = destGss.filter((g) => !known.has(g));
  if (missing.length > 0) {
    const rows = missing.map((gss): Omit<AuthorityRow, "website"> => {
      const isCounty = gss === countyGss;
      const name = (isCounty ? councils?.county?.name : councils?.district.name) ?? gss;
      const type = authorityTypeFromGss(gss) ?? gss.slice(0, 3);
      return {
        gss_code: gss,
        name,
        type,
        parent_gss: !isCounty && type === "E07" ? countyGss : null,
      };
    });
    await repo.ensureAuthorities(rows);
    for (const r of rows) known.set(r.gss_code, r);
  }

  const contacts = await repo.getContacts(destGss);
  const planned: PlannedDelivery[] = resolved.destinations.map((d) => {
    const contact = pickContact(contacts, d.authorityGss, category.id, category.category_group);
    const formUrl = contact?.form_url ?? null;
    const website = known.get(d.authorityGss)?.website ?? null;
    const email = contact?.email ?? null;
    const preferForm = PREFER_FORM_SLUGS.has(category.slug) && !!formUrl;
    if (email && !preferForm) {
      return {
        authorityGss: d.authorityGss,
        policeForceId: null,
        role: d.role,
        channel: "email",
        recipient: email,
      };
    }
    return {
      authorityGss: d.authorityGss,
      policeForceId: null,
      role: d.role,
      channel: "signpost",
      recipient: formUrl ?? website,
    };
  });

  const force = police ? await knownForce(repo, police.force) : null;
  const policeForceId = force?.id ?? null;
  // A police delivery row needs a police_forces FK; if the force is unknown the client can
  // still show the generic 999/101/police.uk signpost from the police_signpost warning.
  if (resolved.policeSignpost && force) {
    planned.push({
      authorityGss: null,
      policeForceId: force.id,
      role: "police_signpost",
      channel: "signpost",
      recipient: force.report_url ?? POLICE_UK_URL,
    });
  }

  const deliveries: NewDelivery[] = planned.map((p) => ({
    report_id: reportId,
    authority_gss: p.authorityGss,
    police_force_id: p.policeForceId,
    channel: p.channel,
    status: "pending",
    recipient: p.recipient,
  }));

  await repo.saveRouting({
    reportId,
    routedAuthorities: destGss,
    policeForceId,
    policeNeighbourhood: police?.neighbourhood ?? null,
    deliveries,
  });

  return {
    kind: "routed",
    reportId,
    routedAuthorities: destGss,
    police,
    deliveries: planned,
    warnings,
  };
}

/**
 * Best contact for an authority and category: a category_id override first, then a
 * category_group match, then a catch-all row (category_group null).
 */
export function pickContact(
  contacts: ContactRow[],
  authorityGss: string,
  categoryId: string | number,
  categoryGroup: string | null,
): ContactRow | null {
  const mine = contacts
    .filter((c) => c.authority_gss === authorityGss && (c.email || c.form_url))
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  return (
    mine.find((c) => c.category_id != null && String(c.category_id) === String(categoryId)) ??
      mine.find((c) =>
        c.category_id == null && categoryGroup != null && c.category_group === categoryGroup
      ) ??
      mine.find((c) => c.category_id == null && c.category_group == null) ??
      null
  );
}

/** The police_forces row if the force is in our table, else null (avoids an FK violation). */
async function knownForce(repo: RoutingRepo, force: string): Promise<PoliceForceRow | null> {
  const row = await repo.getPoliceForce(force);
  if (!row) console.warn(`route-report: police force '${force}' not in police_forces`);
  return row;
}
