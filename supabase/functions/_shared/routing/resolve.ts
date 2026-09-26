// Pure tier resolution (PLAN §5 "Authority tiers"). No I/O.
//
// | GSS | Type                      | Highways            | Waste / district functions |
// |-----|---------------------------|---------------------|----------------------------|
// | E06 | Unitary                   | itself              | itself                     |
// | E07 | Non-metropolitan district | the county (E10)    | itself                     |
// | E08 | Metropolitan district     | itself              | itself                     |
// | E09 | London borough            | itself (+TfL notice)| itself                     |
// | E10 | County council            | itself              | the districts              |

import {
  type AuthorityType,
  authorityTypeFromGss,
  gssPrefix,
  isPseudoGss,
  type RoutingTarget,
} from "./types.ts";

/** What the destination authority is being asked to do. */
export type DestinationRole = "highway" | "waste_collection" | "district_or_unitary" | "asb";

export interface Destination {
  authorityGss: string;
  role: DestinationRole;
}

export type WarningCode =
  /** London highway report: TfL is responsible for red routes. */
  | "london_red_route"
  /** Highway report: motorways / trunk roads belong to National Highways (v1 notice only). */
  | "national_highways"
  /** ASB: tell the user about 999 / 101 / police.uk. */
  | "police_signpost"
  /** Two-tier district but no county was supplied. */
  | "missing_county"
  /** District code is not an English local authority (Wales, Scotland, NI…). */
  | "outside_england"
  /** No district was supplied at all. */
  | "no_district"
  /** Supplied `type` disagreed with the GSS prefix; the prefix was used. */
  | "type_mismatch";

export interface RoutingWarning {
  code: WarningCode;
  message: string;
}

export type UnroutedReason =
  | "outside_england"
  | "no_district"
  | "missing_county"
  | "unsupported_authority_type";

export interface ResolveInput {
  routingTarget: RoutingTarget;
  /** Lower-tier / unitary authority containing the point. `type` defaults to the GSS prefix. */
  district: { gss: string; type?: string | null } | null;
  /** County council for two-tier areas. E99999999 / null means "no county". */
  county?: { gss: string } | null;
}

export interface ResolveResult {
  destinations: Destination[];
  /** True when the user should also be signposted to police (999 / 101 / police.uk). */
  policeSignpost: boolean;
  /** True when no destination could be found and the report needs moderation. */
  unrouted: boolean;
  unroutedReason?: UnroutedReason;
  warnings: RoutingWarning[];
}

const WARN: Record<WarningCode, string> = {
  london_red_route:
    "Red routes in London are managed by Transport for London (TfL). If this is on a red route, report it to TfL instead.",
  national_highways:
    "Motorways and major trunk roads are managed by National Highways, not the council.",
  police_signpost:
    "If anyone is in danger call 999. For non-emergencies call 101 or report online at police.uk.",
  missing_county:
    "This area has a district and a county council, but the county could not be identified.",
  outside_england: "This location is outside England, which this app does not cover yet.",
  no_district: "No council could be found for this location.",
  type_mismatch: "Authority type did not match its GSS code; the GSS code was used.",
};

function warn(code: WarningCode): RoutingWarning {
  return { code, message: WARN[code] };
}

function unrouted(reason: UnroutedReason, warnings: RoutingWarning[]): ResolveResult {
  return { destinations: [], policeSignpost: false, unrouted: true, unroutedReason: reason, warnings };
}

function normaliseCounty(county: ResolveInput["county"]): string | null {
  const gss = county?.gss?.trim();
  if (!gss || isPseudoGss(gss)) return null;
  return authorityTypeFromGss(gss) === "E10" ? gss : null;
}

/**
 * Map a routing target and the councils at a point to destination authorities.
 * Pure and total: never throws; unresolvable inputs return `unrouted: true`.
 */
export function resolveDestinations(input: ResolveInput): ResolveResult {
  const warnings: RoutingWarning[] = [];
  const { routingTarget } = input;

  // police_signpost needs no council at all — the handler attaches the police force.
  if (routingTarget === "police_signpost") {
    // Still England-only: if we were told the district is outside England, say so.
    const dg = input.district?.gss;
    if (dg && !authorityTypeFromGss(dg) && !gssPrefix(dg).startsWith("E")) {
      return unrouted("outside_england", [warn("outside_england")]);
    }
    return {
      destinations: [],
      policeSignpost: true,
      unrouted: false,
      warnings: [warn("police_signpost")],
    };
  }

  const districtGss = input.district?.gss?.trim();
  if (!districtGss) return unrouted("no_district", [warn("no_district")]);

  const prefixType = authorityTypeFromGss(districtGss);
  if (!prefixType) {
    // W06 (Wales), S12 (Scotland), N09 (NI) or unknown.
    return gssPrefix(districtGss).startsWith("E")
      ? unrouted("unsupported_authority_type", [])
      : unrouted("outside_england", [warn("outside_england")]);
  }
  const suppliedType = input.district?.type?.trim().toUpperCase();
  if (suppliedType && suppliedType !== prefixType) warnings.push(warn("type_mismatch"));
  const type: AuthorityType = prefixType;
  const countyGss = normaliseCounty(input.county);

  const destinations: Destination[] = [];
  let policeSignpost = false;

  switch (routingTarget) {
    case "highway": {
      if (type === "E07") {
        if (!countyGss) return unrouted("missing_county", [...warnings, warn("missing_county")]);
        destinations.push({ authorityGss: countyGss, role: "highway" });
      } else {
        // E06, E08, E09 are their own highway authority; E10 (if passed as "district") too.
        destinations.push({ authorityGss: districtGss, role: "highway" });
      }
      warnings.push(warn("national_highways"));
      if (type === "E09") warnings.push(warn("london_red_route"));
      break;
    }
    case "waste_collection":
    case "district_or_unitary":
    case "asb": {
      // A county council never collects waste or runs these services; it needs its district.
      if (type === "E10") return unrouted("unsupported_authority_type", warnings);
      const role: DestinationRole = routingTarget;
      destinations.push({ authorityGss: districtGss, role });
      if (routingTarget === "asb") {
        policeSignpost = true;
        warnings.push(warn("police_signpost"));
      }
      break;
    }
    default: {
      const _exhaustive: never = routingTarget;
      return unrouted("unsupported_authority_type", warnings);
    }
  }

  return { destinations, policeSignpost, unrouted: false, warnings };
}
