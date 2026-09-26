import { router } from 'expo-router';
import { FlatList, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/button';
import { ReportMap } from '@/components/report-map';
import { ReportRow } from '@/components/report-row';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useNearbyReports } from '@/lib/api';
import { formatDistance, useCurrentLocation } from '@/lib/location';

export default function NearbyScreen() {
  const { coords, denied } = useCurrentLocation();
  const nearby = useNearbyReports(coords);

  return (
    <ThemedView style={styles.container}>
      <View style={styles.map}>
        {coords ? (
          <ReportMap
            center={coords}
            reports={nearby.data}
            onPressReport={(r) => router.push({ pathname: '/report/[id]', params: { id: r.id } })}
          />
        ) : (
          <ThemedText style={styles.centered} themeColor="textSecondary">
            Finding your location…
          </ThemedText>
        )}
      </View>

      <SafeAreaView edges={['bottom']} style={styles.sheet}>
        <View style={styles.sheetHeader}>
          <ThemedText type="smallBold">
            {nearby.data
              ? `${nearby.data.length} ${nearby.data.length === 1 ? 'report' : 'reports'} within 2 km`
              : 'Nearby reports'}
          </ThemedText>
          {denied && (
            <ThemedText type="small" themeColor="textSecondary" numberOfLines={1} style={styles.shrink}>
              Location off · showing Maidstone
            </ThemedText>
          )}
        </View>
        {nearby.error ? (
          <ThemedText type="small" themeColor="textSecondary">
            Couldn’t load reports. Is local Supabase running? ({(nearby.error as Error).message})
          </ThemedText>
        ) : (
          <FlatList
            data={nearby.data ?? []}
            keyExtractor={(r) => r.id}
            contentContainerStyle={styles.list}
            renderItem={({ item }) => (
              <ReportRow
                id={item.id}
                title={item.category_name}
                subtitle={[formatDistance(item.distance_m), item.address_text ?? item.description]
                  .filter(Boolean)
                  .join(' · ')}
                status={item.status}
              />
            )}
            ListEmptyComponent={
              nearby.isLoading ? null : (
                <ThemedText type="small" themeColor="textSecondary">
                  Nothing reported nearby yet.
                </ThemedText>
              )
            }
          />
        )}
        <Button title="Report a problem" onPress={() => router.push('/report/new')} />
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  map: { flex: 1, minHeight: 260 },
  centered: { margin: 'auto' },
  sheet: {
    maxHeight: '50%',
    padding: Spacing.three,
    gap: Spacing.two,
  },
  sheetHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: Spacing.two },
  shrink: { flexShrink: 1 },
  list: { gap: Spacing.two },
});
