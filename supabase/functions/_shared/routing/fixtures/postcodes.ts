// Trimmed real responses from api.postcodes.io/postcodes?lon=&lat=&limit=1 (captured 2026-09).
// Only the fields geo.ts reads, plus a few for realism.

function pc(
  postcode: string,
  country: string,
  adminDistrict: string,
  adminCounty: string | null,
  codes: { admin_district: string; admin_county: string },
  distance: number,
) {
  return {
    status: 200,
    result: [{
      postcode,
      country,
      admin_district: adminDistrict,
      admin_county: adminCounty,
      codes: { ...codes, lau2: codes.admin_district },
      distance,
    }],
  };
}

/** Bristol city centre (51.4545, -2.5879): unitary. */
export const BRISTOL = pc("BS1 6WS", "England", "Bristol, City of", null, {
  admin_district: "E06000023",
  admin_county: "E99999999",
}, 23.85);

/** Maidstone (51.2724, 0.5217): two-tier, Maidstone BC + Kent CC. */
export const MAIDSTONE = pc("ME14 1SN", "England", "Maidstone", "Kent", {
  admin_district: "E07000110",
  admin_county: "E10000016",
}, 45.7);

/** Manchester (53.4808, -2.2426): metropolitan district. */
export const MANCHESTER = pc("M2 4NG", "England", "Manchester", null, {
  admin_district: "E08000003",
  admin_county: "E99999999",
}, 27.67);

/** Camden (51.5390, -0.1426): London borough. */
export const CAMDEN = pc("NW1 7PJ", "England", "Camden", null, {
  admin_district: "E09000007",
  admin_county: "E99999999",
}, 31.05);

/** Cardiff (51.4816, -3.1791): Wales. Note W99999999 pseudo county. */
export const CARDIFF = pc("CF10 2AF", "Wales", "Cardiff", null, {
  admin_district: "W06000015",
  admin_county: "W99999999",
}, 19.43);

/** Edinburgh (55.9533, -3.1883): Scotland. */
export const EDINBURGH = pc("EH1 3EG", "Scotland", "City of Edinburgh", null, {
  admin_district: "S12000036",
  admin_county: "S99999999",
}, 14.85);

/** postcodes.io reply when nothing is within the radius. */
export const NO_RESULT = { status: 200, result: null };

/** data.police.uk/api/locate-neighbourhood?q=51.2724,0.5217 */
export const POLICE_MAIDSTONE = { neighbourhood: "YA11", force: "kent" };
