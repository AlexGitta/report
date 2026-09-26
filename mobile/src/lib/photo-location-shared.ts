import type { Coords } from './location';

export function validCoords(lat: number, lng: number): Coords | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) return null;
  return { lat, lng };
}

/** Native pickers return EXIF as a flat dictionary with unsigned coords + N/S/E/W refs. */
export function fromPickerExif(exif: Record<string, unknown> | null | undefined): Coords | null {
  if (!exif) return null;
  const lat = Math.abs(Number(exif.GPSLatitude));
  const lng = Math.abs(Number(exif.GPSLongitude));
  return validCoords(
    exif.GPSLatitudeRef === 'S' ? -lat : lat,
    exif.GPSLongitudeRef === 'W' ? -lng : lng
  );
}
