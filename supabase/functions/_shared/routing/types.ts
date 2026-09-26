// Shared routing types. These mirror the fixed shared contract (see docs/PLAN.md §5, §8).

export type RoutingTarget =
  | "highway"
  | "waste_collection"
  | "district_or_unitary"
  | "asb"
  | "police_signpost";

export const ROUTING_TARGETS: readonly RoutingTarget[] = [
  "highway",
  "waste_collection",
  "district_or_unitary",
  "asb",
  "police_signpost",
];

export function isRoutingTarget(v: unknown): v is RoutingTarget {
  return typeof v === "string" && (ROUTING_TARGETS as readonly string[]).includes(v);
}

/** English local authority types, identified by GSS code prefix. */
export type AuthorityType = "E06" | "E07" | "E08" | "E09" | "E10";

export const ENGLISH_AUTHORITY_TYPES: readonly AuthorityType[] = [
  "E06",
  "E07",
  "E08",
  "E09",
  "E10",
];

/** Returns the 3-char GSS prefix (e.g. "E07") of a code, upper-cased. */
export function gssPrefix(gss: string): string {
  return gss.trim().slice(0, 3).toUpperCase();
}

/** English authority type for a GSS code, or null when it is not an English LA code. */
export function authorityTypeFromGss(gss: string): AuthorityType | null {
  const p = gssPrefix(gss);
  return (ENGLISH_AUTHORITY_TYPES as readonly string[]).includes(p) ? (p as AuthorityType) : null;
}

/** postcodes.io uses this pseudo-code for admin_county in areas with no county council. */
export const NO_COUNTY_GSS = "E99999999";

/** True for ONS "pseudo" codes such as E99999999 / W99999999 / S99999999 ("not applicable"). */
export function isPseudoGss(gss: string | null | undefined): boolean {
  return !gss || /^[A-Z]99999999$/i.test(gss.trim());
}

/** Minimal fetch signature so lookups can be tested with a stub. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
