import 'leaflet/dist/leaflet.css';

import L from 'leaflet';
import { useEffect } from 'react';
import { CircleMarker, MapContainer, Marker, Popup, TileLayer, useMap, useMapEvents } from 'react-leaflet';
import { StyleSheet, View } from 'react-native';

import type { ReportMapProps } from './report-map';

const GROUP_COLOURS: Record<string, string> = {
  roads: '#E65100',
  waste: '#2E7D32',
  street_scene: '#1565C0',
  community_safety: '#6A1B9A',
};

// A CSS-only pin, so we don't depend on Leaflet's image assets resolving through Metro.
const pinIcon = L.divIcon({
  className: '',
  html: '<div style="width:22px;height:22px;border-radius:50% 50% 50% 0;background:#C62828;transform:rotate(-45deg);border:2px solid #fff;box-shadow:0 1px 4px #0006"></div>',
  iconSize: [22, 22],
  iconAnchor: [11, 22],
});

function Recentre({ lat, lng }: { lat: number; lng: number }) {
  const map = useMap();
  useEffect(() => {
    map.setView([lat, lng]);
  }, [map, lat, lng]);
  return null;
}

function ClickToMove({ onPick }: { onPick: (c: { lat: number; lng: number }) => void }) {
  useMapEvents({ click: (e) => onPick({ lat: e.latlng.lat, lng: e.latlng.lng }) });
  return null;
}

export function ReportMap({ center, reports, onPressReport, pin, onPinChange, style }: ReportMapProps) {
  return (
    <View style={[StyleSheet.absoluteFill, style]}>
      <MapContainer
        center={[center.lat, center.lng]}
        zoom={pin ? 17 : 15}
        style={{ width: '100%', height: '100%' }}>
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        {!pin && <Recentre lat={center.lat} lng={center.lng} />}
        {reports?.map((r) => (
          <CircleMarker
            key={r.id}
            center={[r.lat, r.lng]}
            radius={9}
            pathOptions={{ color: '#fff', weight: 2, fillColor: GROUP_COLOURS[r.category_group], fillOpacity: 1 }}>
            <Popup>
              <strong>{r.category_name}</strong>
              <br />
              <a href="#" onClick={(e) => (e.preventDefault(), onPressReport?.(r))}>
                {r.ref}
              </a>
            </Popup>
          </CircleMarker>
        ))}
        {pin && (
          <>
            <Marker
              position={[pin.lat, pin.lng]}
              icon={pinIcon}
              draggable
              eventHandlers={{
                dragend: (e) => {
                  const ll = (e.target as L.Marker).getLatLng();
                  onPinChange?.({ lat: ll.lat, lng: ll.lng });
                },
              }}
            />
            {onPinChange && <ClickToMove onPick={onPinChange} />}
          </>
        )}
      </MapContainer>
    </View>
  );
}
