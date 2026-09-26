import { StyleSheet, View } from 'react-native';

import { ThemedText } from './themed-text';

import { STATUS_LABELS, type ReportStatus } from '@/lib/api';

const COLOURS: Record<ReportStatus, string> = {
  draft: '#757575',
  submitted: '#1565C0',
  sent: '#0277BD',
  acknowledged: '#6A1B9A',
  in_progress: '#EF6C00',
  fixed: '#2E7D32',
  closed: '#616161',
  unrouted: '#C62828',
};

export function StatusBadge({ status }: { status: ReportStatus }) {
  return (
    <View style={[styles.badge, { backgroundColor: COLOURS[status] }]}>
      <ThemedText type="smallBold" style={styles.text}>
        {STATUS_LABELS[status]}
      </ThemedText>
    </View>
  );
}

export function ActionBadge() {
  return (
    <View style={[styles.badge, { backgroundColor: '#B26A00' }]}>
      <ThemedText type="smallBold" style={styles.text}>
        Action needed
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: { paddingHorizontal: 10, paddingVertical: 2, borderRadius: 999 },
  text: { color: '#fff', fontSize: 12, lineHeight: 18 },
});
