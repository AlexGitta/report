import { FlatList, RefreshControl, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ReportRow } from '@/components/report-row';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useMyReports } from '@/lib/api';

export default function MyReportsScreen() {
  const mine = useMyReports();

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView style={styles.container} edges={['top']}>
        <ThemedText type="subtitle" style={styles.title}>
          My reports
        </ThemedText>
        <FlatList
          data={mine.data ?? []}
          keyExtractor={(r) => r.id}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl refreshing={mine.isRefetching} onRefresh={() => mine.refetch()} />
          }
          renderItem={({ item }) => (
            <ReportRow
              id={item.id}
              title={`${item.categories?.name ?? 'Report'} · ${item.ref}`}
              subtitle={new Date(item.created_at).toLocaleDateString('en-GB')}
              status={item.status}
              actionNeeded={item.deliveries.some((d) => d.status === 'needs_user')}
            />
          )}
          ListEmptyComponent={
            mine.isLoading ? null : (
              <ThemedText type="small" themeColor="textSecondary">
                {mine.error
                  ? `Couldn’t load: ${(mine.error as Error).message}`
                  : 'Reports you make on this device show up here.'}
              </ThemedText>
            )
          }
        />
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  title: { paddingHorizontal: Spacing.three, paddingTop: Spacing.three },
  list: { padding: Spacing.three, gap: Spacing.two },
});
