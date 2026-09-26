import * as Clipboard from 'expo-clipboard';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, TextInput, View } from 'react-native';

import { Button } from './button';
import { ThemedText } from './themed-text';
import { ThemedView } from './themed-view';

import { Fonts, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import {
  deliveryTargetName,
  useMarkSubmitted,
  type Delivery,
  type PublicReport,
} from '@/lib/api';
import { supabase } from '@/lib/supabase';

const PHOTO_LINK_TTL = 30 * 24 * 60 * 60; // councils may look days later

function formUrl(d: Delivery) {
  return (
    d.recipient ??
    d.authorities?.website ??
    d.police_forces?.report_url ??
    'https://www.police.uk/'
  );
}

/** Plain text the reporter can paste into a council/police web form. */
async function reportText(r: PublicReport) {
  const lines = [
    `Problem: ${r.category_name}`,
    r.address_text ? `Address: ${r.address_text}` : null,
    `Location: ${r.lat.toFixed(5)}, ${r.lng.toFixed(5)}`,
    `Map: https://www.openstreetmap.org/?mlat=${r.lat.toFixed(5)}&mlon=${r.lng.toFixed(5)}#map=19/${r.lat.toFixed(5)}/${r.lng.toFixed(5)}`,
    r.description ? `\n${r.description}\n` : null,
  ];
  if (r.cover_photo_path) {
    const { data } = await supabase.storage
      .from('report-photos')
      .createSignedUrl(r.cover_photo_path, PHOTO_LINK_TTL);
    if (data?.signedUrl) lines.push(`Photo: ${data.signedUrl}`);
  }
  lines.push(`Reference: ${r.ref}`);
  return lines.filter((l) => l !== null).join('\n');
}

function NeedsUserCard({ report, delivery }: { report: PublicReport; delivery: Delivery }) {
  const theme = useTheme();
  const mark = useMarkSubmitted(report.id);
  const [copied, setCopied] = useState(false);
  const [ref, setRef] = useState('');
  const name = deliveryTargetName(delivery);
  const url = formUrl(delivery);
  const isPolice = !!delivery.police_force_id;

  async function copy() {
    await Clipboard.setStringAsync(await reportText(report));
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  }

  return (
    <ThemedView type="backgroundElement" style={[styles.card, { borderColor: '#B26A00' }]}>
      <ThemedText type="small" style={styles.eyebrow}>
        NEXT STEP
      </ThemedText>
      <ThemedText type="smallBold">Report it to {name}</ThemedText>
      <ThemedText type="small" themeColor="textSecondary">
        {isPolice
          ? 'The police take anti-social behaviour reports through their own website. '
          : `${name} takes reports through its own website. `}
        Copy your report, open their form, paste it in, then come back and tell us.
      </ThemedText>

      <Button title={copied ? 'Copied ✓' : '1. Copy your report'} variant="secondary" onPress={copy} />
      <Button title="2. Open the form ↗" onPress={() => WebBrowser.openBrowserAsync(url)} />

      <ThemedText type="small" themeColor="textSecondary">
        3. Did they give you a reference number? (optional)
      </ThemedText>
      <TextInput
        value={ref}
        onChangeText={setRef}
        placeholder="e.g. 123456789"
        placeholderTextColor={theme.textSecondary}
        maxLength={100}
        style={[styles.input, { color: theme.text, borderColor: theme.border }]}
      />
      <Button
        title="4. I’ve submitted it"
        variant="secondary"
        loading={mark.isPending}
        onPress={() => mark.mutate({ deliveryId: delivery.id, externalRef: ref.trim() })}
      />
      {mark.error && (
        <ThemedText type="small" style={{ color: theme.danger }}>
          {(mark.error as Error).message}
        </ThemedText>
      )}
    </ThemedView>
  );
}

function DoneRow({ delivery }: { delivery: Delivery }) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const name = deliveryTargetName(delivery);
  const when = delivery.sent_at
    ? new Date(delivery.sent_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })
    : '';
  const isEmail = delivery.channel === 'email';

  return (
    <ThemedView type="backgroundElement" style={styles.done}>
      <ThemedText type="smallBold">
        ✓ {isEmail ? `Emailed to ${name}` : `You reported this to ${name}`}
      </ThemedText>
      <ThemedText type="small" themeColor="textSecondary">
        {[when, isEmail ? delivery.recipient : null].filter(Boolean).join(' · ')}
      </ThemedText>
      {delivery.external_ref && (
        <ThemedText type="small" themeColor="textSecondary">
          Their reference: {delivery.external_ref}
        </ThemedText>
      )}
      {isEmail && delivery.email_mode === 'capture' && (
        <ThemedText type="small" style={{ color: '#B26A00' }}>
          Demo mode: captured in the test mailbox, not delivered to the council.
        </ThemedText>
      )}
      {isEmail && delivery.email_text && (
        <>
          <Pressable onPress={() => setOpen((o) => !o)} hitSlop={8}>
            <ThemedText type="smallBold" style={{ color: theme.tint }}>
              {open ? 'Hide email ▲' : 'View email ▼'}
            </ThemedText>
          </Pressable>
          {open && (
            <ThemedView type="background" style={[styles.email, { borderColor: theme.border }]}>
              <ThemedText type="small" themeColor="textSecondary">
                To: {delivery.recipient}
              </ThemedText>
              <ThemedText type="smallBold">{delivery.email_subject}</ThemedText>
              <ThemedText type="small" style={styles.emailBody}>
                {delivery.email_text}
              </ThemedText>
            </ThemedView>
          )}
        </>
      )}
    </ThemedView>
  );
}

type Props = {
  report: PublicReport;
  deliveries: Delivery[] | undefined;
  loading: boolean;
  /** Owner-only: emails wait for a moderator (flagged photo). */
  heldForModeration?: boolean;
};

export function NextSteps({ report, deliveries, loading, heldForModeration }: Props) {
  const young = Date.now() - new Date(report.created_at).getTime() < 60_000;

  if (report.status === 'unrouted') {
    return (
      <ThemedText type="small" themeColor="textSecondary">
        We couldn’t work out which council covers this spot. A moderator will check it.
      </ThemedText>
    );
  }
  if (!deliveries?.length) {
    // Owners see their deliveries; everyone else gets an empty list, so only show
    // the spinner while routing is plausibly still running.
    return loading || (young && report.status === 'submitted') ? (
      <View style={styles.row}>
        <ActivityIndicator />
        <ThemedText type="small" themeColor="textSecondary">
          Finding the right council…
        </ThemedText>
      </View>
    ) : null;
  }

  const needsUser = deliveries.filter((d) => d.status === 'needs_user');
  const done = deliveries.filter((d) => d.status === 'sent' || d.status === 'delivered');
  const inFlight = deliveries.filter((d) => d.status === 'pending' || d.status === 'failed');

  return (
    <View style={styles.section}>
      <ThemedText type="smallBold">Where this report goes</ThemedText>
      {needsUser.map((d) => (
        <NeedsUserCard key={d.id} report={report} delivery={d} />
      ))}
      {done.map((d) => (
        <DoneRow key={d.id} delivery={d} />
      ))}
      {heldForModeration && inFlight.length > 0 ? (
        <ThemedView type="backgroundElement" style={styles.done}>
          <ThemedText type="smallBold">Held for a quick check</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            Our photo check wasn’t sure this shows a local problem, so a moderator will look at it before we
            email {inFlight.map(deliveryTargetName).join(' and ')}.
          </ThemedText>
        </ThemedView>
      ) : (
        inFlight.map((d) => (
          <ThemedText key={d.id} type="small" themeColor="textSecondary">
            {d.status === 'failed' ? 'Retrying' : 'Sending'} to {deliveryTargetName(d)}…
          </ThemedText>
        ))
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: Spacing.two, marginTop: Spacing.two },
  card: { borderWidth: 2, borderRadius: Spacing.three, padding: Spacing.three, gap: Spacing.two },
  eyebrow: { color: '#B26A00', letterSpacing: 1 },
  row: { flexDirection: 'row', gap: Spacing.two, alignItems: 'center' },
  flex: { flex: 1 },
  input: {
    borderWidth: 1,
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    fontSize: 16,
  },
  done: { padding: Spacing.three, borderRadius: Spacing.three, gap: Spacing.one },
  email: { borderWidth: 1, borderRadius: Spacing.two, padding: Spacing.three, gap: Spacing.one },
  emailBody: { fontFamily: Fonts.mono, fontSize: 12, lineHeight: 18 },
});
