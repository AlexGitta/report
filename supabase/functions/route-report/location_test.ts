import { assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import { parsePoint } from "./location.ts";

// SELECT ST_GeogFromText('SRID=4326;POINT(0.5217 51.2724)')::text
function ewkbHex(lng: number, lat: number, srid = true): string {
  const buf = new ArrayBuffer(srid ? 25 : 21);
  const dv = new DataView(buf);
  dv.setUint8(0, 1);
  dv.setUint32(1, srid ? 0x20000001 : 1, true);
  let off = 5;
  if (srid) {
    dv.setUint32(off, 4326, true);
    off += 4;
  }
  dv.setFloat64(off, lng, true);
  dv.setFloat64(off + 8, lat, true);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

Deno.test("parsePoint: known PostGIS EWKB hex", () => {
  // ST_SetSRID(ST_MakePoint(-0.1426, 51.539), 4326)::geography
  const p = parsePoint(ewkbHex(-0.1426, 51.539));
  assertAlmostEquals(p!.lng, -0.1426, 1e-9);
  assertAlmostEquals(p!.lat, 51.539, 1e-9);
});

Deno.test("parsePoint: WKB without SRID", () => {
  const p = parsePoint(ewkbHex(0.5217, 51.2724, false));
  assertAlmostEquals(p!.lat, 51.2724, 1e-9);
});

Deno.test("parsePoint: GeoJSON object and string, WKT", () => {
  assertEquals(parsePoint({ type: "Point", coordinates: [-2.5879, 51.4545] }), {
    lat: 51.4545,
    lng: -2.5879,
  });
  assertEquals(parsePoint('{"type":"Point","coordinates":[1,2]}'), { lat: 2, lng: 1 });
  assertEquals(parsePoint("SRID=4326;POINT(-2.2426 53.4808)"), { lat: 53.4808, lng: -2.2426 });
});

Deno.test("parsePoint: garbage -> null", () => {
  assertEquals(parsePoint(null), null);
  assertEquals(parsePoint(""), null);
  assertEquals(parsePoint("POLYGON((0 0,1 1,1 0,0 0))"), null);
  assertEquals(parsePoint({ type: "Point", coordinates: [200, 100] }), null);
  assertEquals(parsePoint("0101"), null);
});
