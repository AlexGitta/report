import * as Location from 'expo-location';
import { useCallback, useEffect, useState } from 'react';

export type Coords = { lat: number; lng: number };

// Maidstone town centre: a two-tier (Kent + district) area, handy for testing routing.
export const FALLBACK_COORDS: Coords = { lat: 51.2724, lng: 0.5226 };

export function useCurrentLocation() {
  const [coords, setCoords] = useState<Coords | null>(null);
  const [denied, setDenied] = useState(false);

  const refresh = useCallback(async () => {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') {
      setDenied(true);
      setCoords((c) => c ?? FALLBACK_COORDS);
      return;
    }
    setDenied(false);
    try {
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      setCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude });
    } catch {
      setCoords((c) => c ?? FALLBACK_COORDS);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { coords, denied, refresh };
}

export function formatDistance(m?: number) {
  if (m == null) return '';
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}
