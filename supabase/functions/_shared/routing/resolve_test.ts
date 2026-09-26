import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import { resolveDestinations, type ResolveResult } from "./resolve.ts";

const BRISTOL = { gss: "E06000023", type: "E06" };
const MAIDSTONE = { gss: "E07000110", type: "E07" };
const KENT = { gss: "E10000016" };
const MANCHESTER = { gss: "E08000003", type: "E08" };
const CAMDEN = { gss: "E09000007", type: "E09" };

const codes = (r: ResolveResult) => r.warnings.map((w) => w.code);

Deno.test("unitary (Bristol): does highways and waste itself", () => {
  const hw = resolveDestinations({ routingTarget: "highway", district: BRISTOL });
  assertEquals(hw.destinations, [{ authorityGss: "E06000023", role: "highway" }]);
  assertFalse(hw.unrouted);
  assertFalse(hw.policeSignpost);
  assert(codes(hw).includes("national_highways"));
  assertFalse(codes(hw).includes("london_red_route"));

  const waste = resolveDestinations({ routingTarget: "waste_collection", district: BRISTOL });
  assertEquals(waste.destinations, [{ authorityGss: "E06000023", role: "waste_collection" }]);

  const dist = resolveDestinations({ routingTarget: "district_or_unitary", district: BRISTOL });
  assertEquals(dist.destinations, [{ authorityGss: "E06000023", role: "district_or_unitary" }]);
});

Deno.test("unitary ignores a pseudo county code (E99999999)", () => {
  const r = resolveDestinations({
    routingTarget: "highway",
    district: BRISTOL,
    county: { gss: "E99999999" },
  });
  assertEquals(r.destinations, [{ authorityGss: "E06000023", role: "highway" }]);
});

Deno.test("two-tier (Maidstone + Kent): pothole goes to the county", () => {
  const r = resolveDestinations({ routingTarget: "highway", district: MAIDSTONE, county: KENT });
  assertEquals(r.destinations, [{ authorityGss: "E10000016", role: "highway" }]);
  assertFalse(r.unrouted);
});

Deno.test("two-tier (Maidstone + Kent): missed bin goes to the district", () => {
  const r = resolveDestinations({
    routingTarget: "waste_collection",
    district: MAIDSTONE,
    county: KENT,
  });
  assertEquals(r.destinations, [{ authorityGss: "E07000110", role: "waste_collection" }]);
});

Deno.test("two-tier: graffiti / noise (district_or_unitary) goes to the district", () => {
  const r = resolveDestinations({
    routingTarget: "district_or_unitary",
    district: MAIDSTONE,
    county: KENT,
  });
  assertEquals(r.destinations, [{ authorityGss: "E07000110", role: "district_or_unitary" }]);
});

Deno.test("metropolitan (Manchester): itself for everything", () => {
  for (const t of ["highway", "waste_collection", "district_or_unitary"] as const) {
    const r = resolveDestinations({ routingTarget: t, district: MANCHESTER });
    assertEquals(r.destinations, [{ authorityGss: "E08000003", role: t }]);
  }
});

Deno.test("London (Camden): highway to borough plus TfL red route notice", () => {
  const r = resolveDestinations({ routingTarget: "highway", district: CAMDEN });
  assertEquals(r.destinations, [{ authorityGss: "E09000007", role: "highway" }]);
  assert(codes(r).includes("london_red_route"));

  const w = resolveDestinations({ routingTarget: "waste_collection", district: CAMDEN });
  assertEquals(w.destinations, [{ authorityGss: "E09000007", role: "waste_collection" }]);
  assertFalse(codes(w).includes("london_red_route"));
});

Deno.test("ASB: district/unitary ASB team plus police signpost", () => {
  const two = resolveDestinations({ routingTarget: "asb", district: MAIDSTONE, county: KENT });
  assertEquals(two.destinations, [{ authorityGss: "E07000110", role: "asb" }]);
  assert(two.policeSignpost);
  assert(codes(two).includes("police_signpost"));

  const uni = resolveDestinations({ routingTarget: "asb", district: BRISTOL });
  assertEquals(uni.destinations, [{ authorityGss: "E06000023", role: "asb" }]);
  assert(uni.policeSignpost);
});

Deno.test("police_signpost target: no council destination, just the police flag", () => {
  const r = resolveDestinations({ routingTarget: "police_signpost", district: CAMDEN });
  assertEquals(r.destinations, []);
  assert(r.policeSignpost);
  assertFalse(r.unrouted);
});

Deno.test("two-tier with missing county: highway is unrouted, waste still works", () => {
  for (const county of [undefined, null, { gss: "E99999999" }]) {
    const r = resolveDestinations({ routingTarget: "highway", district: MAIDSTONE, county });
    assert(r.unrouted);
    assertEquals(r.unroutedReason, "missing_county");
    assertEquals(r.destinations, []);
    assert(codes(r).includes("missing_county"));
  }
  const waste = resolveDestinations({ routingTarget: "waste_collection", district: MAIDSTONE });
  assertEquals(waste.destinations, [{ authorityGss: "E07000110", role: "waste_collection" }]);
});

Deno.test("outside England (Wales W06, Scotland S12) is unrouted", () => {
  for (const gss of ["W06000015", "S12000036", "N09000003"]) {
    for (const t of ["highway", "waste_collection", "asb", "police_signpost"] as const) {
      const r = resolveDestinations({ routingTarget: t, district: { gss }, county: { gss: "W99999999" } });
      assert(r.unrouted, `${gss} ${t}`);
      assertEquals(r.unroutedReason, "outside_england");
      assertEquals(r.destinations, []);
      assertFalse(r.policeSignpost);
    }
  }
});

Deno.test("no district at all is unrouted", () => {
  const r = resolveDestinations({ routingTarget: "highway", district: null });
  assert(r.unrouted);
  assertEquals(r.unroutedReason, "no_district");
});

Deno.test("type is derived from GSS prefix; mismatch warns but prefix wins", () => {
  const r = resolveDestinations({
    routingTarget: "highway",
    district: { gss: "E07000110", type: "E06" },
    county: KENT,
  });
  assertEquals(r.destinations, [{ authorityGss: "E10000016", role: "highway" }]);
  assert(codes(r).includes("type_mismatch"));

  const noType = resolveDestinations({ routingTarget: "highway", district: { gss: "E09000007" } });
  assert(codes(noType).includes("london_red_route"));
});

Deno.test("a county passed as the district cannot take waste reports", () => {
  const r = resolveDestinations({ routingTarget: "waste_collection", district: KENT });
  assert(r.unrouted);
  const hw = resolveDestinations({ routingTarget: "highway", district: KENT });
  assertEquals(hw.destinations, [{ authorityGss: "E10000016", role: "highway" }]);
});
