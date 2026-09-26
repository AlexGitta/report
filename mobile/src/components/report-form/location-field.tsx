import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Button } from '../button';
import { ReportMap } from '../report-map';
import { ThemedText } from '../themed-text';
import { ThemedView } from '../themed-view';

import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import type { Coords } from '@/lib/location';

export type PinSource = 'device' | 'photo' | 'manual' | 'fallback';

const SOURCE_LABELS: Record<PinSource, string> = {
  device: 'your current location',
  photo: 'where the photo was taken',
  manual: 'the spot you picked',
  fallback: 'a default spot: please adjust',
};

/**
 * Street-level label for a point. Nominatim is fine for development; production
 * needs our own geocoder or a paid provider (OSM usage policy).
 */
function useStreetName(pin: Coords | null) {
  return useQuery({
    queryKey: ['revgeo', pin?.lat.toFixed(4), pin?.lng.toFixed(4)],
    enabled: !!pin,
    staleTime: Infinity,
    queryFn: async () => {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=17&lat=${pin!.lat}&lon=${pin!.lng}`,
        { headers: { 'Accept-Language': 'en-GB' } }
      );
      if (!res.ok) return null;
      const j = await res.json();
      const a = j.address ?? {};
      const street = a.road ?? a.pedestrian ?? a.footway ?? a.neighbourhood;
      const place = a.suburb ?? a.village ?? a.town ?? a.city;
      return [street, place].filter(Boolean).join(', ') || null;
    },
  });
}

type Props = {
  pin: Coords | null;
  source: PinSource;
  onChange: (c: Coords, source: PinSource) => void;
  deviceCoords: Coords | null;
  /** Set when a chosen photo had no GPS, so we can say why we used the device. */
  photoLacksGps: boolean;
  /** Street-level label for the pin, once known (used as the report's address). */
  onLabel?: (label: string | null) => void;
};

export function LocationField({ pin, source, onChange, deviceCoords, photoLacksGps, onLabel }: Props) {
  const theme = useTheme();
  const [open, setOpen] = useState(source === 'fallback');
  const [mapKey, setMapKey] = useState(0);
  const street = useStreetName(pin);

  useEffect(() => {
    onLabel?.(street.data ?? null);
  }, [street.data, onLabel]);

  // A guessed location must be confirmed, so open the map for it.
  useEffect(() => {
    if (source === 'fallback') setOpen(true);
  }, [source]);

  if (!pin) {
    return (
      <ThemedText type="small" themeColor="textSecondary">
        Finding your location…
      </ThemedText>
    );
  }

  return (
    <View style={styles.stack}>
      <ThemedView type="backgroundElement" style={styles.summary}>
        <View style={styles.flex}>
          <ThemedText type="smallBold" numberOfLines={1}>
            📍 {street.data ?? `${pin.lat.toFixed(5)}, ${pin.lng.toFixed(5)}`}
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            Using {SOURCE_LABELS[source]}
            {source === 'device' && photoLacksGps ? ' (your photo had no location)' : ''}
          </ThemedText>
        </View>
        <Pressable onPress={() => setOpen((o) => !o)} hitSlop={8} style={styles.adjust}>
          <ThemedText type="smallBold" style={{ color: theme.tint }}>
            {open ? 'Done' : 'Adjust'}
          </ThemedText>
        </Pressable>
      </ThemedView>

      {open && (
        <>
          <ThemedText type="small" themeColor="textSecondary">
            Tap the map or drag the pin to the exact spot.
          </ThemedText>
          <View style={styles.map}>
            <ReportMap key={`${mapKey}-${source === 'manual' ? 'm' : source}`} center={pin} pin={pin} onPinChange={(c) => onChange(c, 'manual')} />
          </View>
          {source !== 'device' && deviceCoords && (
            <Button
              title="Use my current location"
              variant="secondary"
              onPress={() => {
                onChange(deviceCoords, 'device');
                setMapKey((k) => k + 1);
              }}
            />
          )}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: Spacing.two },
  summary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    padding: Spacing.three,
    borderRadius: Spacing.three,
  },
  flex: { flex: 1, minWidth: 0 },
  adjust: { paddingHorizontal: Spacing.two, paddingVertical: Spacing.one },
  map: { height: 240, borderRadius: Spacing.three, overflow: 'hidden' },
});
