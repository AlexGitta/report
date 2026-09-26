import { router } from 'expo-router';
import { Pressable, StyleSheet } from 'react-native';

import { ThemedText } from './themed-text';

import { useTheme } from '@/hooks/use-theme';

/**
 * Header back button that always works: goes back when there is history, otherwise
 * home (e.g. after submitting, which replaces the form, or a deep link opened on web).
 */
export function BackButton() {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Back"
      hitSlop={12}
      onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
      style={({ pressed }) => [styles.button, pressed && { opacity: 0.6 }]}>
      <ThemedText type="smallBold" style={{ color: theme.tint }}>
        ‹ Back
      </ThemedText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { paddingHorizontal: 12, paddingVertical: 6 },
});
