import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import MapView, { Marker } from 'react-native-maps';

import type { PublicReport } from '@/lib/api';
import type { Coords } from '@/lib/location';

export type ReportMapProps = {
  center: Coords;
  reports?: PublicReport[];
  onPressReport?: (r: PublicReport) => void;
  /** When set, shows a draggable pin for choosing a report location. */
  pin?: Coords;
  onPinChange?: (c: Coords) => void;
  style?: StyleProp<ViewStyle>;
};

const GROUP_COLOURS: Record<string, string> = {
  roads: '#E65100',
  waste: '#2E7D32',
  street_scene: '#1565C0',
  community_safety: '#6A1B9A',
};

export function ReportMap({ center, reports, onPressReport, pin, onPinChange, style }: ReportMapProps) {
  return (
    <MapView
      style={[StyleSheet.absoluteFill, style]}
      showsUserLocation
      initialRegion={{
        latitude: center.lat,
        longitude: center.lng,
        latitudeDelta: pin ? 0.004 : 0.02,
        longitudeDelta: pin ? 0.004 : 0.02,
      }}
      onPress={
        onPinChange
          ? (e) =>
              onPinChange({
                lat: e.nativeEvent.coordinate.latitude,
                lng: e.nativeEvent.coordinate.longitude,
              })
          : undefined
      }>
      {reports?.map((r) => (
        <Marker
          key={r.id}
          coordinate={{ latitude: r.lat, longitude: r.lng }}
          pinColor={GROUP_COLOURS[r.category_group]}
          title={r.category_name}
          description={r.ref}
          onCalloutPress={() => onPressReport?.(r)}
        />
      ))}
      {pin && (
        <Marker
          draggable
          coordinate={{ latitude: pin.lat, longitude: pin.lng }}
          onDragEnd={(e) =>
            onPinChange?.({
              lat: e.nativeEvent.coordinate.latitude,
              lng: e.nativeEvent.coordinate.longitude,
            })
          }
        />
      )}
    </MapView>
  );
}
