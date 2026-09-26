// Parse a PostGIS geography(Point,4326) value as it arrives via PostgREST / supabase-js.
// PostgREST returns geography columns as hex EWKB by default; GeoJSON and WKT are accepted too.

export interface LatLng {
  lat: number;
  lng: number;
}

export function parsePoint(value: unknown): LatLng | null {
  if (value == null) return null;
  if (typeof value === "object") return fromGeoJson(value as Record<string, unknown>);
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (/^[0-9a-f]+$/i.test(s)) return fromHexEwkb(s);
  if (s.startsWith("{")) {
    try {
      return fromGeoJson(JSON.parse(s));
    } catch {
      return null;
    }
  }
  return fromWkt(s);
}

function valid(lng: number, lat: number): LatLng | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

function fromGeoJson(g: Record<string, unknown>): LatLng | null {
  if (g?.type !== "Point" || !Array.isArray(g.coordinates)) return null;
  const [lng, lat] = g.coordinates as unknown[];
  return typeof lng === "number" && typeof lat === "number" ? valid(lng, lat) : null;
}

function fromWkt(s: string): LatLng | null {
  const m = s.replace(/^SRID=\d+;/i, "").match(
    /^POINT\s*\(\s*(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s*\)$/i,
  );
  return m ? valid(Number(m[1]), Number(m[2])) : null;
}

function fromHexEwkb(hex: string): LatLng | null {
  if (hex.length % 2 !== 0 || hex.length < 42) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  const dv = new DataView(bytes.buffer);
  const le = bytes[0] === 1;
  const rawType = dv.getUint32(1, le);
  const hasSrid = (rawType & 0x20000000) !== 0;
  const geomType = rawType & 0x0fffffff;
  if (geomType !== 1) return null; // not a Point
  let off = 5 + (hasSrid ? 4 : 0);
  if (bytes.length < off + 16) return null;
  const x = dv.getFloat64(off, le);
  off += 8;
  const y = dv.getFloat64(off, le);
  return valid(x, y);
}
