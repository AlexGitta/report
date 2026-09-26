// Point -> council and point -> police lookups (PLAN §5 "Lookup pipeline", v1).
//
// - Councils: postcodes.io reverse geocode, widening the radius until a postcode is found.
// - Police:   data.police.uk locate-neighbourhood.
//
// Both accept an injectable fetch for tests. "No result" returns null; infrastructure
// problems (timeouts, 5xx, garbage responses) throw a GeoLookupError, which callers should
// treat as retryable rather than as "unroutable".

import { type FetchLike, isPseudoGss } from "./types.ts";

export type GeoLookupErrorKind =
  | "invalid_input"
  | "timeout"
  | "network"
  | "http"
  | "bad_response";

export class GeoLookupError extends Error {
  readonly kind: GeoLookupErrorKind;
  readonly service: "postcodes.io" | "police.uk";
  readonly status?: number;

  constructor(
    service: "postcodes.io" | "police.uk",
    kind: GeoLookupErrorKind,
    message: string,
    opts: { status?: number; cause?: unknown } = {},
  ) {
    super(`[${service}] ${kind}: ${message}`, { cause: opts.cause });
    this.name = "GeoLookupError";
    this.service = service;
    this.kind = kind;
    this.status = opts.status;
  }

  /** Timeouts, network failures, 429 and 5xx are worth retrying later. */
  get retryable(): boolean {
    if (this.kind === "timeout" || this.kind === "network") return true;
    if (this.kind === "http") return this.status === 429 || (this.status ?? 0) >= 500;
    return false;
  }
}

export interface LookupOptions {
  fetch?: FetchLike;
  /** Per-request timeout in ms (default 5000). */
  timeoutMs?: number;
  /** Override the API base URL (tests / self-hosted mirror). */
  baseUrl?: string;
}

export interface CouncilLookupOptions extends LookupOptions {
  /** Radii (m) tried in order. postcodes.io caps radius at 2000. Default [100, 300, 750, 2000]. */
  radii?: number[];
}

export interface CouncilArea {
  gss: string;
  name: string | null;
}

export interface CouncilLookupResult {
  /** Lower-tier / unitary authority (postcodes.io `admin_district`). E06/E07/E08/E09 in England. */
  district: CouncilArea;
  /** County council (postcodes.io `admin_county`) — null outside two-tier areas. */
  county: CouncilArea | null;
  /** postcodes.io `country`, e.g. "England", "Wales". */
  country: string | null;
  /** The postcode the point was matched to, and how far away it was. */
  postcode: string | null;
  distanceM: number | null;
  radiusM: number;
}

export interface PoliceLookupResult {
  /** police.uk force slug, e.g. "kent", "metropolitan". Matches police_forces.id. */
  force: string;
  /** police.uk neighbourhood id within the force. */
  neighbourhood: string;
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_RADII = [100, 300, 750, 2000];
const MAX_RADIUS = 2000;
const POSTCODES_BASE = "https://api.postcodes.io";
const POLICE_BASE = "https://data.police.uk/api";

function validateLatLng(service: "postcodes.io" | "police.uk", lat: number, lng: number) {
  if (
    typeof lat !== "number" || typeof lng !== "number" ||
    !Number.isFinite(lat) || !Number.isFinite(lng) ||
    lat < -90 || lat > 90 || lng < -180 || lng > 180
  ) {
    throw new GeoLookupError(service, "invalid_input", `invalid coordinates lat=${lat} lng=${lng}`);
  }
}

async function fetchWithTimeout(
  service: "postcodes.io" | "police.uk",
  url: string,
  opts: LookupOptions,
): Promise<Response> {
  const f: FetchLike = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new GeoLookupError(service, "timeout", `no response within ${timeoutMs}ms (${url})`));
    }, timeoutMs);
  });
  try {
    // Race as well as abort, so a stub fetch that ignores the signal still times out.
    return await Promise.race([
      f(url, { signal: controller.signal, headers: { accept: "application/json" } }),
      timeout,
    ]);
  } catch (err) {
    if (err instanceof GeoLookupError) throw err;
    throw new GeoLookupError(service, "network", `request failed (${url}): ${String(err)}`, {
      cause: err,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(service: "postcodes.io" | "police.uk", res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch (err) {
    throw new GeoLookupError(service, "bad_response", "response body was not JSON", {
      status: res.status,
      cause: err,
    });
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

/**
 * Reverse-geocode a point to its councils via postcodes.io.
 *
 * Returns null when no postcode is found within the largest radius (e.g. offshore, or very
 * remote land). Throws GeoLookupError for service failures.
 */
export async function lookupCouncils(
  lat: number,
  lng: number,
  opts: CouncilLookupOptions = {},
): Promise<CouncilLookupResult | null> {
  validateLatLng("postcodes.io", lat, lng);
  const base = (opts.baseUrl ?? POSTCODES_BASE).replace(/\/$/, "");
  const radii = (opts.radii ?? DEFAULT_RADII)
    .map((r) => Math.min(Math.max(1, Math.round(r)), MAX_RADIUS));

  for (const radius of radii) {
    const url = `${base}/postcodes?lon=${lng}&lat=${lat}&radius=${radius}&limit=1`;
    const res = await fetchWithTimeout("postcodes.io", url, opts);
    if (res.status === 404) {
      // Not expected for this endpoint, but treat as "nothing here" and widen.
      await res.body?.cancel();
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new GeoLookupError("postcodes.io", "http", `HTTP ${res.status}`, { status: res.status });
    }
    const body = await readJson("postcodes.io", res);
    if (!isObj(body)) {
      throw new GeoLookupError("postcodes.io", "bad_response", "expected an object");
    }
    const result = body.result;
    if (result === null || (Array.isArray(result) && result.length === 0)) continue;
    if (!Array.isArray(result) || !isObj(result[0])) {
      throw new GeoLookupError("postcodes.io", "bad_response", "expected result[] of postcodes");
    }
    return parsePostcode(result[0], radius);
  }
  return null;
}

function parsePostcode(pc: Record<string, unknown>, radius: number): CouncilLookupResult {
  const codes = isObj(pc.codes) ? pc.codes : {};
  const districtGss = str(codes.admin_district);
  if (!districtGss) {
    throw new GeoLookupError("postcodes.io", "bad_response", "postcode has no codes.admin_district");
  }
  const countyGss = str(codes.admin_county);
  const county: CouncilArea | null =
    countyGss && !isPseudoGss(countyGss) && countyGss !== districtGss
      ? { gss: countyGss, name: str(pc.admin_county) }
      : null;
  return {
    district: { gss: districtGss, name: str(pc.admin_district) },
    county,
    country: str(pc.country),
    postcode: str(pc.postcode),
    distanceM: typeof pc.distance === "number" ? pc.distance : null,
    radiusM: radius,
  };
}

/**
 * Find the police force and neighbourhood for a point via data.police.uk.
 * Returns null when police.uk has no neighbourhood for the point (HTTP 404, e.g. offshore
 * or Scotland, which police.uk does not cover).
 */
export async function lookupPolice(
  lat: number,
  lng: number,
  opts: LookupOptions = {},
): Promise<PoliceLookupResult | null> {
  validateLatLng("police.uk", lat, lng);
  const base = (opts.baseUrl ?? POLICE_BASE).replace(/\/$/, "");
  const url = `${base}/locate-neighbourhood?q=${lat},${lng}`;
  const res = await fetchWithTimeout("police.uk", url, opts);
  if (res.status === 404) {
    await res.body?.cancel();
    return null;
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new GeoLookupError("police.uk", "http", `HTTP ${res.status}`, { status: res.status });
  }
  const body = await readJson("police.uk", res);
  if (!isObj(body)) throw new GeoLookupError("police.uk", "bad_response", "expected an object");
  const force = str(body.force);
  const neighbourhood = str(body.neighbourhood);
  if (!force || !neighbourhood) {
    throw new GeoLookupError("police.uk", "bad_response", "missing force or neighbourhood");
  }
  return { force, neighbourhood };
}
