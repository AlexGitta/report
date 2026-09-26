import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { GeoLookupError, lookupCouncils, lookupPolice } from "./geo.ts";
import type { FetchLike } from "./types.ts";
import * as fx from "./fixtures/postcodes.ts";

type Route = (url: URL) => Response | Promise<Response>;

/** A stub fetch that records requested URLs and answers via `route`. */
function mockFetch(route: Route): FetchLike & { calls: URL[] } {
  const calls: URL[] = [];
  const f = (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(url);
    return Promise.resolve(route(url));
  };
  return Object.assign(f, { calls });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

Deno.test("lookupCouncils: unitary (Bristol), pseudo county dropped", async () => {
  const f = mockFetch(() => json(fx.BRISTOL));
  const r = await lookupCouncils(51.4545, -2.5879, { fetch: f });
  assert(r);
  assertEquals(r.district, { gss: "E06000023", name: "Bristol, City of" });
  assertEquals(r.county, null);
  assertEquals(r.country, "England");
  assertEquals(r.postcode, "BS1 6WS");
  const u = f.calls[0];
  assertEquals(u.origin + u.pathname, "https://api.postcodes.io/postcodes");
  assertEquals(u.searchParams.get("lat"), "51.4545");
  assertEquals(u.searchParams.get("lon"), "-2.5879");
  assertEquals(u.searchParams.get("limit"), "1");
  assertEquals(u.searchParams.get("radius"), "100");
});

Deno.test("lookupCouncils: two-tier (Maidstone + Kent)", async () => {
  const r = await lookupCouncils(51.2724, 0.5217, { fetch: mockFetch(() => json(fx.MAIDSTONE)) });
  assertEquals(r?.district, { gss: "E07000110", name: "Maidstone" });
  assertEquals(r?.county, { gss: "E10000016", name: "Kent" });
});

Deno.test("lookupCouncils: metropolitan and London", async () => {
  const m = await lookupCouncils(53.4808, -2.2426, { fetch: mockFetch(() => json(fx.MANCHESTER)) });
  assertEquals(m?.district.gss, "E08000003");
  assertEquals(m?.county, null);
  const c = await lookupCouncils(51.539, -0.1426, { fetch: mockFetch(() => json(fx.CAMDEN)) });
  assertEquals(c?.district.gss, "E09000007");
  assertEquals(c?.county, null);
});

Deno.test("lookupCouncils: Wales / Scotland pass through with pseudo county dropped", async () => {
  const w = await lookupCouncils(51.4816, -3.1791, { fetch: mockFetch(() => json(fx.CARDIFF)) });
  assertEquals(w?.district.gss, "W06000015");
  assertEquals(w?.county, null);
  assertEquals(w?.country, "Wales");
  const s = await lookupCouncils(55.9533, -3.1883, { fetch: mockFetch(() => json(fx.EDINBURGH)) });
  assertEquals(s?.district.gss, "S12000036");
  assertEquals(s?.county, null);
});

Deno.test("lookupCouncils: widens radius progressively up to 2000m", async () => {
  const f = mockFetch((u) => json(u.searchParams.get("radius") === "2000" ? fx.MAIDSTONE : fx.NO_RESULT));
  const r = await lookupCouncils(51.2, 0.6, { fetch: f });
  assertEquals(r?.district.gss, "E07000110");
  assertEquals(r?.radiusM, 2000);
  assertEquals(f.calls.map((u) => u.searchParams.get("radius")), ["100", "300", "750", "2000"]);
});

Deno.test("lookupCouncils: returns null when nothing within 2000m", async () => {
  const f = mockFetch(() => json(fx.NO_RESULT));
  assertEquals(await lookupCouncils(50.0, -1.0, { fetch: f }), null);
  assertEquals(f.calls.length, 4);
});

Deno.test("lookupCouncils: radius is clamped to 2000", async () => {
  const f = mockFetch(() => json(fx.NO_RESULT));
  await lookupCouncils(50, -1, { fetch: f, radii: [5000] });
  assertEquals(f.calls[0].searchParams.get("radius"), "2000");
});

Deno.test("lookupCouncils: HTTP 500 throws retryable GeoLookupError", async () => {
  const err = await assertRejects(
    () => lookupCouncils(51, 0, { fetch: mockFetch(() => json({ status: 500 }, 500)) }),
    GeoLookupError,
  );
  assertEquals(err.kind, "http");
  assertEquals(err.status, 500);
  assert(err.retryable);
});

Deno.test("lookupCouncils: non-JSON / malformed body -> bad_response", async () => {
  const e1 = await assertRejects(
    () => lookupCouncils(51, 0, { fetch: mockFetch(() => new Response("<html>")) }),
    GeoLookupError,
  );
  assertEquals(e1.kind, "bad_response");
  const e2 = await assertRejects(
    () =>
      lookupCouncils(51, 0, {
        fetch: mockFetch(() => json({ status: 200, result: [{ postcode: "X", codes: {} }] })),
      }),
    GeoLookupError,
  );
  assertEquals(e2.kind, "bad_response");
});

Deno.test("lookupCouncils: network failure -> network error", async () => {
  const f: FetchLike = () => Promise.reject(new TypeError("connection refused"));
  const err = await assertRejects(() => lookupCouncils(51, 0, { fetch: f }), GeoLookupError);
  assertEquals(err.kind, "network");
  assert(err.retryable);
});

Deno.test("lookupCouncils: times out even if fetch ignores the abort signal", async () => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hang: FetchLike = () =>
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(json(fx.BRISTOL)), 1000);
    });
  const err = await assertRejects(
    () => lookupCouncils(51, 0, { fetch: hang, timeoutMs: 20 }),
    GeoLookupError,
  );
  clearTimeout(timer);
  assertEquals(err.kind, "timeout");
});

Deno.test("lookupCouncils: invalid coordinates", async () => {
  const f = mockFetch(() => json(fx.BRISTOL));
  const err = await assertRejects(() => lookupCouncils(NaN, 0, { fetch: f }), GeoLookupError);
  assertEquals(err.kind, "invalid_input");
  await assertRejects(() => lookupCouncils(91, 0, { fetch: f }), GeoLookupError);
  assertEquals(f.calls.length, 0);
});

Deno.test("lookupPolice: returns force and neighbourhood", async () => {
  const f = mockFetch(() => json(fx.POLICE_MAIDSTONE));
  const r = await lookupPolice(51.2724, 0.5217, { fetch: f });
  assertEquals(r, { force: "kent", neighbourhood: "YA11" });
  const u = f.calls[0];
  assertEquals(u.origin + u.pathname, "https://data.police.uk/api/locate-neighbourhood");
  assertEquals(u.searchParams.get("q"), "51.2724,0.5217");
});

Deno.test("lookupPolice: 404 -> null (e.g. Scotland, offshore)", async () => {
  const r = await lookupPolice(55.95, -3.18, {
    fetch: mockFetch(() => new Response("Not found", { status: 404 })),
  });
  assertEquals(r, null);
});

Deno.test("lookupPolice: 503 throws retryable; malformed throws bad_response", async () => {
  const e1 = await assertRejects(
    () => lookupPolice(51, 0, { fetch: mockFetch(() => new Response("", { status: 503 })) }),
    GeoLookupError,
  );
  assert(e1.retryable);
  assertEquals(e1.service, "police.uk");
  const e2 = await assertRejects(
    () => lookupPolice(51, 0, { fetch: mockFetch(() => json({ force: "kent" })) }),
    GeoLookupError,
  );
  assertEquals(e2.kind, "bad_response");
});

// Live smoke test against the real APIs: ROUTING_LIVE_TESTS=1 deno test --allow-net --allow-env
Deno.test({
  name: "LIVE: Maidstone resolves to Maidstone + Kent, force kent",
  ignore: (() => {
    try {
      return Deno.env.get("ROUTING_LIVE_TESTS") !== "1";
    } catch {
      return true;
    }
  })(),
  fn: async () => {
    const c = await lookupCouncils(51.2724, 0.5217);
    assertEquals(c?.district.gss, "E07000110");
    assertEquals(c?.county?.gss, "E10000016");
    const p = await lookupPolice(51.2724, 0.5217);
    assertEquals(p?.force, "kent");
  },
});
