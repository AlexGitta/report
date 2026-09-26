import { Image } from 'expo-image';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, View } from 'react-native';

import { Button } from '@/components/button';
import { NextSteps } from '@/components/next-steps';
import { StatusBadge } from '@/components/status-badge';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import {
  STATUS_LABELS,
  useAddUpdate,
  useDeliveries,
  usePhotoUrl,
  useReport,
  type ReportUpdate,
} from '@/lib/api';

function describeUpdate(u: ReportUpdate) {
  switch (u.kind) {
    case 'status':
      return u.status_to ? STATUS_LABELS[u.status_to] : 'Status changed';
    case 'still_there':
      return 'Someone says it’s still there';
    case 'fixed':
      return 'Marked as fixed';
    default:
      return 'Comment';
  }
}

export default function ReportDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const q = useReport(id);
  const photo = usePhotoUrl(q.data?.report?.cover_photo_path);
  const update = useAddUpdate(id);
  const deliveries = useDeliveries(id, q.data?.report?.created_at);

  // Delivery changes the report's status and timeline; refresh them when it lands.
  const deliveriesUpdatedAt = deliveries.dataUpdatedAt;
  const refetchReport = q.refetch;
  useEffect(() => {
    if (deliveriesUpdatedAt) refetchReport();
  }, [deliveriesUpdatedAt, refetchReport]);

  if (q.isLoading) return <ActivityIndicator style={styles.loading} />;
  const r = q.data?.report;
  if (!r) {
    return (
      <ThemedView style={styles.container}>
        <ThemedText style={styles.pad}>
          {q.error ? (q.error as Error).message : 'Report not found or not public.'}
        </ThemedText>
      </ThemedView>
    );
  }

  const open = !['fixed', 'closed'].includes(r.status);

  return (
    <ThemedView style={styles.container}>
      <Stack.Screen options={{ title: r.ref }} />
      <ScrollView contentContainerStyle={styles.pad}>
        {photo.data && <Image source={{ uri: photo.data }} style={styles.photo} contentFit="cover" />}

        <View style={styles.headerRow}>
          <ThemedText type="subtitle" style={styles.flex}>
            {r.category_name}
          </ThemedText>
          <StatusBadge status={r.status} />
        </View>
        {r.address_text && <ThemedText themeColor="textSecondary">{r.address_text}</ThemedText>}
        {r.location_is_approximate && (
          <ThemedText type="small" themeColor="textSecondary">
            Location shown approximately for privacy.
          </ThemedText>
        )}
        {r.description && <ThemedText>{r.description}</ThemedText>}

        <NextSteps
          report={r}
          deliveries={deliveries.data}
          loading={deliveries.isLoading}
          heldForModeration={q.data?.needsModeration}
        />

        {open && (
          <View style={styles.actions}>
            <Button
              title={`Still there (${r.still_there_count})`}
              variant="secondary"
              style={styles.flex}
              loading={update.isPending && update.variables === 'still_there'}
              onPress={() => update.mutate('still_there')}
            />
            <Button
              title="It’s fixed"
              variant="secondary"
              style={styles.flex}
              loading={update.isPending && update.variables === 'fixed'}
              onPress={() => update.mutate('fixed')}
            />
          </View>
        )}
        {update.error && (
          <ThemedText type="small" themeColor="textSecondary">
            {(update.error as Error).message}
          </ThemedText>
        )}

        <ThemedText type="smallBold" style={styles.timelineTitle}>
          Timeline
        </ThemedText>
        {q.data!.updates.map((u) => (
          <ThemedView key={u.id} type="backgroundElement" style={styles.update}>
            <ThemedText type="smallBold">{describeUpdate(u)}</ThemedText>
            {u.body && <ThemedText type="small">{u.body}</ThemedText>}
            <ThemedText type="small" themeColor="textSecondary">
              {new Date(u.created_at).toLocaleString('en-GB')}
            </ThemedText>
          </ThemedView>
        ))}
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  loading: { flex: 1 },
  pad: { padding: Spacing.three, gap: Spacing.two },
  photo: { width: '100%', aspectRatio: 4 / 3, borderRadius: Spacing.three },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  flex: { flex: 1 },
  actions: { flexDirection: 'row', gap: Spacing.two, marginTop: Spacing.two },
  timelineTitle: { marginTop: Spacing.three },
  update: { padding: Spacing.three, borderRadius: Spacing.three, gap: Spacing.half },
});
