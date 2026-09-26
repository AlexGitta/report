import { Link } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';

import { ActionBadge, StatusBadge } from './status-badge';
import { ThemedText } from './themed-text';
import { ThemedView } from './themed-view';

import { Spacing } from '@/constants/theme';
import type { ReportStatus } from '@/lib/api';

type Props = {
  id: string;
  title: string;
  subtitle?: string;
  status: ReportStatus;
  /** Reporter still has to submit on a council/police site. */
  actionNeeded?: boolean;
};

export function ReportRow({ id, title, subtitle, status, actionNeeded }: Props) {
  return (
    <Link href={{ pathname: '/report/[id]', params: { id } }} asChild>
      <Pressable style={({ pressed }) => pressed && { opacity: 0.7 }}>
        <ThemedView type="backgroundElement" style={styles.row}>
          <View style={styles.text}>
            <ThemedText type="smallBold">{title}</ThemedText>
            {subtitle ? (
              <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
                {subtitle}
              </ThemedText>
            ) : null}
          </View>
          {actionNeeded ? <ActionBadge /> : <StatusBadge status={status} />}
        </ThemedView>
      </Pressable>
    </Link>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    padding: Spacing.three,
    borderRadius: Spacing.three,
  },
  text: { flex: 1, minWidth: 0 },
});
