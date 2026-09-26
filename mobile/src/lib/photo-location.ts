import type { ImagePickerAsset } from 'expo-image-picker';

import type { Coords } from './location';
import { fromPickerExif } from './photo-location-shared';

/**
 * Where the photo was taken, if the image still carries GPS metadata.
 * Often it won't: many phones/pickers strip location for privacy (see PLAN.md §4).
 * Native: the picker returns EXIF (with `exif: true`). Web: see photo-location.web.ts.
 */
export async function photoCoords(asset: ImagePickerAsset): Promise<Coords | null> {
  return fromPickerExif(asset.exif);
}
