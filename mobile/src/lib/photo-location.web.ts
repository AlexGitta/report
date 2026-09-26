// exifr assumes a browser/Node runtime and crashes on import in React Native, so it
// lives only in the web build.
import exifr from 'exifr';
import type { ImagePickerAsset } from 'expo-image-picker';

import type { Coords } from './location';
import { fromPickerExif, validCoords } from './photo-location-shared';

/** expo-image-picker doesn't return EXIF on web, but gives us the original File. */
export async function photoCoords(asset: ImagePickerAsset): Promise<Coords | null> {
  const fromPicker = fromPickerExif(asset.exif);
  if (fromPicker) return fromPicker;
  if (!asset.file) return null;
  try {
    const gps = await exifr.gps(asset.file);
    return gps ? validCoords(gps.latitude, gps.longitude) : null;
  } catch {
    return null; // No EXIF / unsupported format.
  }
}
