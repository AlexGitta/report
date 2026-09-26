import { Image } from 'expo-image';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';

import { Button } from '@/components/button';
import { CategoryPicker, type Suggestion } from '@/components/report-form/category-picker';
import { LocationField, type PinSource } from '@/components/report-form/location-field';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useCategories, useClassifyPhoto, useCreateReport, type Category } from '@/lib/api';
import { useCurrentLocation, type Coords } from '@/lib/location';
import { photoCoords } from '@/lib/photo-location';

type Photo = { uri: string; width: number; height: number; aiBase64?: string };

/** Stored photo: plenty for a council to see the problem. */
const MAX_EDGE = 1280;
/** Copy sent to the AI: small upload on slow links, and fewer image tokens. */
const AI_MAX_EDGE = 1024;
/** At or above this, the AI's top guess is chosen for the user. */
const AUTO_SELECT_CONFIDENCE = 0.5;

async function resized(uri: string, width: number, height: number, maxEdge: number, compress: number, base64: boolean) {
  const ctx = ImageManipulator.manipulate(uri);
  if (Math.max(width, height) > maxEdge) {
    ctx.resize(width >= height ? { width: maxEdge } : { height: maxEdge });
  }
  const image = await ctx.renderAsync();
  return image.saveAsync({ format: SaveFormat.JPEG, compress, base64 });
}

async function preparePhoto(asset: ImagePicker.ImagePickerAsset): Promise<Photo> {
  const stored = await resized(asset.uri, asset.width, asset.height, MAX_EDGE, 0.75, false);
  const ai = await resized(stored.uri, stored.width, stored.height, AI_MAX_EDGE, 0.6, true);
  return { uri: stored.uri, width: stored.width, height: stored.height, aiBase64: ai.base64 };
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <ThemedText type="smallBold">{title}</ThemedText>
      {children}
    </View>
  );
}

function Chip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={[
        styles.chip,
        { borderColor: selected ? theme.tint : theme.border },
        selected && { backgroundColor: theme.tint },
      ]}>
      <ThemedText type="small" style={selected ? { color: theme.onTint } : undefined}>
        {label}
      </ThemedText>
    </Pressable>
  );
}

export default function NewReportScreen() {
  const theme = useTheme();
  const { coords, denied } = useCurrentLocation();
  const categories = useCategories();
  const create = useCreateReport();
  const classify = useClassifyPhoto();

  const [photo, setPhoto] = useState<Photo | null>(null);
  const [skipPhoto, setSkipPhoto] = useState(false);
  const [photoLacksGps, setPhotoLacksGps] = useState(false);
  const [pin, setPin] = useState<Coords | null>(null);
  const [pinSource, setPinSource] = useState<PinSource>('device');
  const [category, setCategory] = useState<Category | null>(null);
  const [chosenByUser, setChosenByUser] = useState(false);
  const [description, setDescription] = useState('');
  const [address, setAddress] = useState('');
  const [streetLabel, setStreetLabel] = useState<string | null>(null);
  const [extra, setExtra] = useState<Record<string, string>>({});

  useEffect(() => {
    if (coords && !pin) {
      setPin(coords);
      setPinSource(denied ? 'fallback' : 'device');
    }
  }, [coords, denied, pin]);

  async function pick(source: 'camera' | 'library') {
    const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 1, exif: true };
    if (source === 'camera') {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) return;
    }
    const res =
      source === 'camera'
        ? await ImagePicker.launchCameraAsync(opts)
        : await ImagePicker.launchImageLibraryAsync(opts);
    if (res.canceled || !res.assets[0]) return;
    const asset = res.assets[0];

    // A camera photo was taken where the user is standing; a library photo's own
    // GPS (when it survives) beats the device location.
    if (source === 'library') {
      const fromPhoto = await photoCoords(asset);
      setPhotoLacksGps(!fromPhoto);
      if (fromPhoto) {
        setPin(fromPhoto);
        setPinSource('photo');
      }
    }

    const prepared = await preparePhoto(asset);
    setPhoto(prepared);
    setSkipPhoto(false);
    if (!prepared.aiBase64) return;
    classify.reset();
    classify.mutate(prepared.aiBase64, {
      onSuccess: (ai) => {
        const top = ai.candidates[0];
        const match = categories.data?.find((c) => c.slug === top?.category);
        if (match && top.confidence >= AUTO_SELECT_CONFIDENCE && !chosenByUser) setCategory(match);
        setDescription((d) => d || ai.description);
      },
    });
  }

  function removePhoto() {
    setPhoto(null);
    setPhotoLacksGps(false);
    classify.reset();
    if (!chosenByUser) setCategory(null);
    if (pinSource === 'photo' && coords) {
      setPin(coords);
      setPinSource(denied ? 'fallback' : 'device');
    }
  }

  function chooseCategory(c: Category) {
    setCategory(c);
    setChosenByUser(true);
    setExtra({});
  }

  const aiTop = classify.data?.candidates[0];
  const suggestions: Suggestion[] = (classify.data?.candidates ?? [])
    .map((s) => ({ category: categories.data?.find((c) => c.slug === s.category), confidence: s.confidence }))
    .filter((s): s is Suggestion => !!s.category && s.confidence >= 0.1);

  const sourceLabel =
    category && !chosenByUser && aiTop?.category === category.slug
      ? `Detected from your photo · ${Math.round(aiTop.confidence * 100)}% sure`
      : undefined;

  const missing = !category
    ? 'Choose what the problem is'
    : !pin
      ? 'Waiting for a location'
      : category.requires_address && !address.trim()
        ? 'Add the address'
        : category.extra_fields.find((f) => f.required && !extra[f.key]?.trim())?.label;

  async function submit() {
    if (!category || !pin) return;
    const created = await create.mutateAsync({
      categorySlug: category.slug,
      lat: pin.lat,
      lng: pin.lng,
      description: description.trim(),
      // Councils want a street, not just coordinates; fall back to the pin's street name.
      addressText: address.trim() || streetLabel || undefined,
      extra,
      photo: photo ?? undefined,
      ai: classify.data ?? null,
    });
    router.replace({ pathname: '/report/[id]', params: { id: created.id } });
  }

  const inputStyle = [styles.input, { color: theme.text, borderColor: theme.border }];
  const showCategory = !!photo || skipPhoto;

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ThemedView style={styles.flex}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {/* 1. Photo */}
          {photo ? (
            <Pressable onPress={removePhoto}>
              <Image source={{ uri: photo.uri }} style={styles.photo} contentFit="cover" />
              <ThemedText type="small" themeColor="textSecondary">
                Tap photo to remove
              </ThemedText>
            </Pressable>
          ) : (
            <Section title="Add a photo of the problem">
              <ThemedText type="small" themeColor="textSecondary">
                We’ll work out what it is and where it was taken.
              </ThemedText>
              <View style={styles.row}>
                {Platform.OS !== 'web' && (
                  <Button title="Take photo" style={styles.flex} onPress={() => pick('camera')} />
                )}
                <Button
                  title="Choose photo"
                  variant={Platform.OS === 'web' ? 'primary' : 'secondary'}
                  style={styles.flex}
                  onPress={() => pick('library')}
                />
              </View>
              {!skipPhoto && (
                <Pressable onPress={() => setSkipPhoto(true)} hitSlop={8}>
                  <ThemedText type="small" style={{ color: theme.tint }}>
                    No photo? Continue without one ›
                  </ThemedText>
                </Pressable>
              )}
            </Section>
          )}

          {/* 2. What's the problem */}
          {showCategory && (
            <Section title="What’s the problem?">
              <CategoryPicker
                categories={categories.data ?? []}
                value={category}
                onChange={chooseCategory}
                sourceLabel={sourceLabel}
                suggestions={suggestions}
                detecting={classify.isPending}
                detectFailed={classify.isError}
              />
              {classify.data?.unsafe_or_irrelevant && (
                <View style={styles.field}>
                  <ThemedText type="small" style={{ color: theme.danger }}>
                    This photo doesn’t look like a local problem. If you keep it, a moderator will check it
                    before it goes to the council.
                  </ThemedText>
                  <Pressable onPress={removePhoto} hitSlop={8}>
                    <ThemedText type="smallBold" style={{ color: theme.tint }}>
                      Remove photo and send straight away
                    </ThemedText>
                  </Pressable>
                </View>
              )}
            </Section>
          )}

          {/* Everything below depends on the category */}
          {category && (
            <>
              {category.safety_interstitial && (
                <ThemedView type="backgroundElement" style={[styles.safety, { borderColor: theme.danger }]}>
                  <ThemedText type="smallBold">If anyone is in immediate danger, call 999.</ThemedText>
                  <ThemedText type="small">
                    Non-emergency police: 101. We’ll send this to the council and show you how to tell the
                    police too.
                  </ThemedText>
                  <View style={styles.row}>
                    <Button title="Call 999" style={styles.flex} onPress={() => Linking.openURL('tel:999')} />
                    <Button
                      title="Call 101"
                      variant="secondary"
                      style={styles.flex}
                      onPress={() => Linking.openURL('tel:101')}
                    />
                  </View>
                </ThemedView>
              )}

              {(category.extra_fields.length > 0 || category.requires_address) && (
                <Section title="A few details">
                  {category.requires_address && (
                    <View style={styles.field}>
                      <ThemedText type="small">Address</ThemedText>
                      <TextInput
                        style={inputStyle}
                        value={address}
                        onChangeText={setAddress}
                        placeholder="House number and street"
                        placeholderTextColor={theme.textSecondary}
                      />
                    </View>
                  )}
                  {category.extra_fields.map((f) => (
                    <View key={f.key} style={styles.field}>
                      <ThemedText type="small">
                        {f.label}
                        {f.required ? '' : ' (optional)'}
                      </ThemedText>
                      {f.type === 'select' && f.options ? (
                        <View style={styles.chips}>
                          {f.options.map((o) => (
                            <Chip
                              key={o}
                              label={o}
                              selected={extra[f.key] === o}
                              onPress={() => setExtra((e) => ({ ...e, [f.key]: o }))}
                            />
                          ))}
                        </View>
                      ) : (
                        <TextInput
                          style={inputStyle}
                          value={extra[f.key] ?? ''}
                          onChangeText={(t) => setExtra((e) => ({ ...e, [f.key]: t }))}
                          placeholder={f.hint}
                          placeholderTextColor={theme.textSecondary}
                        />
                      )}
                    </View>
                  ))}
                </Section>
              )}

              <Section title="Where is it?">
                <LocationField
                  pin={pin}
                  source={pinSource}
                  deviceCoords={denied ? null : coords}
                  photoLacksGps={photoLacksGps}
                  onLabel={setStreetLabel}
                  onChange={(c, s) => {
                    setPin(c);
                    setPinSource(s);
                  }}
                />
              </Section>

              <Section title="Anything else? (optional)">
                <TextInput
                  style={[inputStyle, styles.multiline]}
                  value={description}
                  onChangeText={setDescription}
                  multiline
                  maxLength={1000}
                  placeholder="Size, how long it’s been there, how to find it…"
                  placeholderTextColor={theme.textSecondary}
                />
              </Section>

              {create.error && (
                <ThemedText type="small" style={{ color: theme.danger }}>
                  {(create.error as Error).message}
                </ThemedText>
              )}
              <Button
                title={missing ?? 'Send report'}
                disabled={!!missing}
                loading={create.isPending}
                onPress={submit}
              />
            </>
          )}
        </ScrollView>
      </ThemedView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: Spacing.three, gap: Spacing.four, paddingBottom: Spacing.six },
  section: { gap: Spacing.two },
  field: { gap: Spacing.one },
  row: { flexDirection: 'row', gap: Spacing.two, alignItems: 'center' },
  photo: { width: '100%', aspectRatio: 4 / 3, borderRadius: Spacing.three },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two },
  chip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.one,
  },
  safety: { borderWidth: 2, borderRadius: Spacing.three, padding: Spacing.three, gap: Spacing.two },
  input: {
    borderWidth: 1,
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    fontSize: 16,
  },
  multiline: { minHeight: 96, textAlignVertical: 'top' },
});
