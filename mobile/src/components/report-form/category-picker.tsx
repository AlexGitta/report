import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '../themed-text';
import { ThemedView } from '../themed-view';

import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import type { Category, CategoryGroup } from '@/lib/api';

const GROUPS: { group: CategoryGroup; title: string; examples: string }[] = [
  { group: 'roads', title: 'Roads & pavements', examples: 'Potholes, broken paving, signs' },
  { group: 'waste', title: 'Bins & rubbish', examples: 'Missed bins, fly-tipping, dog mess' },
  { group: 'street_scene', title: 'Street problems', examples: 'Graffiti, lights, abandoned cars' },
  { group: 'community_safety', title: 'Safety & nuisance', examples: 'ASB, noise, needles' },
];

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export type Suggestion = { category: Category; confidence: number };

type Props = {
  categories: Category[];
  value: Category | null;
  onChange: (c: Category) => void;
  /** Shown above the chosen category, e.g. "Detected from your photo". */
  sourceLabel?: string;
  /** AI guesses when it wasn't confident enough to choose. */
  suggestions: Suggestion[];
  detecting: boolean;
  detectFailed: boolean;
};

type Mode = { kind: 'auto' } | { kind: 'groups' } | { kind: 'group'; group: CategoryGroup };

export function CategoryPicker({
  categories,
  value,
  onChange,
  sourceLabel,
  suggestions,
  detecting,
  detectFailed,
}: Props) {
  const theme = useTheme();
  const [mode, setMode] = useState<Mode>({ kind: 'auto' });

  // A new value (from the user or the AI) collapses the picker back to its summary.
  useEffect(() => {
    if (value) setMode({ kind: 'auto' });
  }, [value]);

  const byGroup = useMemo(() => {
    const m = new Map<CategoryGroup, Category[]>();
    for (const c of categories) m.set(c.category_group, [...(m.get(c.category_group) ?? []), c]);
    return m;
  }, [categories]);

  function pick(c: Category) {
    onChange(c);
    setMode({ kind: 'auto' });
  }

  // Explicit browsing wins over everything else.
  if (mode.kind === 'group') {
    const cats = byGroup.get(mode.group) ?? [];
    const g = GROUPS.find((x) => x.group === mode.group)!;
    return (
      <View style={styles.stack}>
        <Pressable onPress={() => setMode({ kind: 'groups' })} hitSlop={8}>
          <ThemedText type="small" style={{ color: theme.tint }}>
            ‹ All categories
          </ThemedText>
        </Pressable>
        <ThemedText type="smallBold">{g.title}</ThemedText>
        {cats.map((c) => (
          <OptionRow
            key={c.id}
            title={c.name}
            subtitle={c.description}
            selected={value?.id === c.id}
            onPress={() => pick(c)}
          />
        ))}
      </View>
    );
  }

  if (mode.kind === 'groups' || (!value && !detecting && suggestions.length === 0)) {
    return (
      <View style={styles.stack}>
        {detectFailed && (
          <ThemedText type="small" themeColor="textSecondary">
            We couldn’t tell from the photo. What kind of problem is it?
          </ThemedText>
        )}
        {/* Explicit 2x2 rows with fixed-height tiles so every tile is the same size. */}
        {chunk(GROUPS.filter((g) => byGroup.has(g.group)), 2).map((row) => (
          <View key={row[0].group} style={styles.gridRow}>
            {row.map((g) => (
              <Pressable
                key={g.group}
                onPress={() => setMode({ kind: 'group', group: g.group })}
                style={({ pressed }) => [styles.tile, pressed && styles.pressed]}>
                <ThemedView type="backgroundElement" style={styles.tileInner}>
                  <ThemedText type="smallBold" numberOfLines={1}>
                    {g.title}
                  </ThemedText>
                  <ThemedText type="small" themeColor="textSecondary" numberOfLines={2}>
                    {g.examples}
                  </ThemedText>
                </ThemedView>
              </Pressable>
            ))}
            {row.length === 1 && <View style={styles.tile} />}
          </View>
        ))}
        {value && (
          <Pressable onPress={() => setMode({ kind: 'auto' })} hitSlop={8}>
            <ThemedText type="small" style={{ color: theme.tint }}>
              Keep “{value.name}”
            </ThemedText>
          </Pressable>
        )}
      </View>
    );
  }

  if (detecting && !value) {
    return (
      <ThemedView type="backgroundElement" style={[styles.card, styles.row]}>
        <ActivityIndicator color={theme.tint} />
        <ThemedText type="small">Working out what’s in your photo…</ThemedText>
      </ThemedView>
    );
  }

  if (value) {
    return (
      <ThemedView type="backgroundElement" style={[styles.card, styles.row, { borderColor: theme.tint }]}>
        <View style={styles.flex}>
          {sourceLabel && (
            <ThemedText type="small" themeColor="textSecondary">
              {sourceLabel}
            </ThemedText>
          )}
          <ThemedText type="smallBold" style={styles.big}>
            {value.name}
          </ThemedText>
        </View>
        <Pressable onPress={() => setMode({ kind: 'groups' })} hitSlop={8} style={styles.change}>
          <ThemedText type="smallBold" style={{ color: theme.tint }}>
            Change
          </ThemedText>
        </Pressable>
      </ThemedView>
    );
  }

  // AI wasn't sure: offer its best guesses as one-tap answers.
  return (
    <View style={styles.stack}>
      <ThemedText type="small" themeColor="textSecondary">
        Is it one of these?
      </ThemedText>
      {suggestions.slice(0, 3).map((s) => (
        <OptionRow
          key={s.category.id}
          title={s.category.name}
          subtitle={s.category.description}
          selected={false}
          onPress={() => pick(s.category)}
        />
      ))}
      <OptionRow title="Something else" selected={false} onPress={() => setMode({ kind: 'groups' })} />
    </View>
  );
}

function OptionRow({
  title,
  subtitle,
  selected,
  onPress,
}: {
  title: string;
  subtitle?: string;
  selected: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable onPress={onPress} style={({ pressed }) => pressed && styles.pressed}>
      <ThemedView
        type="backgroundElement"
        style={[styles.option, { borderColor: selected ? theme.tint : 'transparent' }]}>
        <View style={styles.flex}>
          <ThemedText type="smallBold">{title}</ThemedText>
          {subtitle && (
            <ThemedText type="small" themeColor="textSecondary" numberOfLines={2}>
              {subtitle}
            </ThemedText>
          )}
        </View>
        <ThemedText themeColor="textSecondary">›</ThemedText>
      </ThemedView>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  stack: { gap: Spacing.two },
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  flex: { flex: 1, minWidth: 0 },
  gridRow: { flexDirection: 'row', gap: Spacing.two },
  tile: { flex: 1, height: 96 },
  tileInner: { flex: 1, padding: Spacing.three, borderRadius: Spacing.three, gap: Spacing.half },
  pressed: { opacity: 0.7 },
  card: { padding: Spacing.three, borderRadius: Spacing.three, borderWidth: 1, borderColor: 'transparent' },
  big: { fontSize: 20, lineHeight: 26 },
  change: { paddingHorizontal: Spacing.two, paddingVertical: Spacing.one },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    padding: Spacing.three,
    borderRadius: Spacing.three,
    borderWidth: 1,
    minHeight: 72,
  },
});
