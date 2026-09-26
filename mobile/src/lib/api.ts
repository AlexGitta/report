import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { ensureSession, supabase } from './supabase';

export type CategoryGroup = 'roads' | 'waste' | 'street_scene' | 'community_safety';

export const GROUP_LABELS: Record<CategoryGroup, string> = {
  roads: 'Roads & pavements',
  waste: 'Waste',
  street_scene: 'Street scene',
  community_safety: 'ASB & community safety',
};

export type ExtraField = {
  key: string;
  label: string;
  type: 'text' | 'select' | 'date';
  required?: boolean;
  options?: string[];
  hint?: string;
};

export type Category = {
  id: number;
  slug: string;
  category_group: CategoryGroup;
  name: string;
  description: string;
  urgent: boolean;
  requires_address: boolean;
  safety_interstitial: boolean;
  extra_fields: ExtraField[];
  sort_order: number;
};

export type ReportStatus =
  | 'draft'
  | 'submitted'
  | 'sent'
  | 'acknowledged'
  | 'in_progress'
  | 'fixed'
  | 'closed'
  | 'unrouted';

export const STATUS_LABELS: Record<ReportStatus, string> = {
  draft: 'Draft',
  submitted: 'Submitted',
  sent: 'Sent to council',
  acknowledged: 'Acknowledged',
  in_progress: 'In progress',
  fixed: 'Fixed',
  closed: 'Closed',
  unrouted: 'Needs routing',
};

export type PublicReport = {
  id: string;
  ref: string;
  category_slug: string;
  category_name: string;
  category_group: CategoryGroup;
  urgent: boolean;
  status: ReportStatus;
  lat: number;
  lng: number;
  location_is_approximate: boolean;
  address_text: string | null;
  description: string | null;
  severity: string | null;
  reporter_display_name: string | null;
  still_there_count: number;
  cover_photo_path: string | null;
  created_at: string;
  updated_at: string;
  distance_m?: number;
  routed_authorities?: string[] | null;
  police_force_id?: string | null;
};

export type ReportUpdate = {
  id: number;
  report_id: string;
  actor_type: string;
  kind: 'status' | 'comment' | 'still_there' | 'fixed';
  status_to: ReportStatus | null;
  body: string | null;
  created_at: string;
};

export function useCategories() {
  return useQuery({
    queryKey: ['categories'],
    staleTime: 60 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('categories')
        .select(
          'id, slug, category_group, name, description, urgent, requires_address, safety_interstitial, extra_fields, sort_order'
        )
        .eq('active', true)
        .order('sort_order');
      if (error) throw error;
      return data as Category[];
    },
  });
}

export function useNearbyReports(coords: { lat: number; lng: number } | null, radiusM = 2000) {
  return useQuery({
    queryKey: ['reports_near', coords?.lat.toFixed(3), coords?.lng.toFixed(3), radiusM],
    enabled: !!coords,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('reports_near', {
        lat: coords!.lat,
        lng: coords!.lng,
        radius_m: radiusM,
      });
      if (error) throw error;
      return data as PublicReport[];
    },
  });
}

export function useMyReports() {
  return useQuery({
    queryKey: ['my_reports'],
    queryFn: async () => {
      const session = await ensureSession();
      const { data, error } = await supabase
        .from('reports')
        .select('id, ref, status, created_at, description, categories(name, slug), deliveries(status)')
        .eq('reporter_id', session!.user.id)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data as unknown as {
        id: string;
        ref: string;
        status: ReportStatus;
        created_at: string;
        description: string | null;
        categories: { name: string; slug: string } | null;
        deliveries: { status: Delivery['status'] }[];
      }[];
    },
  });
}

export function useReport(id: string) {
  return useQuery({
    queryKey: ['report', id],
    queryFn: async () => {
      const [report, updates, own] = await Promise.all([
        supabase.from('public_reports').select('*').eq('id', id).maybeSingle(),
        supabase
          .from('public_report_updates')
          .select('*')
          .eq('report_id', id)
          .order('created_at', { ascending: true }),
        // Only the owner can read the base row (RLS); null for everyone else.
        supabase.from('reports').select('needs_moderation').eq('id', id).maybeSingle(),
      ]);
      if (report.error) throw report.error;
      if (updates.error) throw updates.error;
      return {
        report: report.data as PublicReport | null,
        updates: updates.data as ReportUpdate[],
        needsModeration: own.data?.needs_moderation === true,
      };
    },
  });
}

export function usePhotoUrl(path: string | null | undefined) {
  return useQuery({
    queryKey: ['photo', path],
    enabled: !!path,
    staleTime: 50 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase.storage
        .from('report-photos')
        .createSignedUrl(path!, 60 * 60);
      if (error) throw error;
      return data.signedUrl;
    },
  });
}

export type AiClassification = {
  candidates: { category: string; confidence: number }[];
  description: string;
  severity: 'low' | 'medium' | 'high';
  contains_people: boolean;
  contains_plates: boolean;
  unsafe_or_irrelevant: boolean;
  reason: string;
};

/** Suggests a category from the photo. Failures are non-fatal: the user just picks manually. */
export function useClassifyPhoto() {
  return useMutation({
    mutationFn: async (imageBase64: string) => {
      await ensureSession();
      const { data, error } = await supabase.functions.invoke('classify-photo', {
        body: { image_base64: imageBase64, media_type: 'image/jpeg' },
      });
      if (error) throw error;
      if (!data?.ok) throw new Error(data?.error?.message ?? 'Classification failed');
      return data.result as AiClassification;
    },
  });
}

export type NewReport = {
  categorySlug: string;
  lat: number;
  lng: number;
  description: string;
  addressText?: string;
  extra?: Record<string, string>;
  photo?: { uri: string; width: number; height: number };
  ai?: AiClassification | null;
};

/**
 * Creates the report and returns as soon as it exists, so "Send" feels instant.
 * The photo upload and routing then run in the background, in that order, so the
 * council email includes the photo. The report page polls and fills in as they land.
 */
export function useCreateReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (r: NewReport) => {
      await ensureSession();
      const { data, error } = await supabase.rpc('create_report', {
        category_slug: r.categorySlug,
        lat: r.lat,
        lng: r.lng,
        description: r.description || null,
        address_text: r.addressText || null,
        extra: r.extra ?? {},
        severity: r.ai?.severity ?? null,
        ai_result: r.ai ?? null,
      });
      if (error) throw error;
      const created = (Array.isArray(data) ? data[0] : data) as { id: string; ref: string };

      finishReport(created.id, r)
        .catch((e) => console.warn('Finishing report failed', e))
        .finally(() => {
          qc.invalidateQueries({ queryKey: ['report', created.id] });
          qc.invalidateQueries({ queryKey: ['deliveries', created.id] });
        });
      return created;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['reports_near'] });
      qc.invalidateQueries({ queryKey: ['my_reports'] });
    },
  });
}

async function finishReport(reportId: string, r: NewReport) {
  if (r.photo) {
    try {
      const path = `${reportId}/${Date.now()}.jpg`;
      const body = await (await fetch(r.photo.uri)).arrayBuffer();
      const up = await supabase.storage.from('report-photos').upload(path, body, { contentType: 'image/jpeg' });
      if (up.error) throw up.error;
      const reg = await supabase.rpc('add_report_photo', {
        report_id: reportId,
        storage_path: path,
        width: r.photo.width,
        height: r.photo.height,
        // Without an AI verdict, keep the photo private until a moderator checks it.
        contains_people: r.ai?.contains_people ?? true,
        contains_plates: r.ai?.contains_plates ?? true,
      });
      if (reg.error) throw reg.error;
    } catch (e) {
      // Still route the report: a council would rather get it without the photo.
      console.warn('Photo upload failed', e);
    }
  }
  await supabase.functions.invoke('route-report', { body: { report_id: reportId } });
}

export function useAddUpdate(reportId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (kind: 'still_there' | 'fixed') => {
      await ensureSession();
      const { error } = await supabase.rpc('add_report_update', { report_id: reportId, kind });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['report', reportId] }),
  });
}

export type Delivery = {
  id: number;
  channel: 'email' | 'signpost' | 'open311';
  status: 'pending' | 'sent' | 'delivered' | 'needs_user' | 'failed' | 'bounced';
  recipient: string | null;
  external_ref: string | null;
  sent_at: string | null;
  email_subject: string | null;
  email_text: string | null;
  /** capture = caught by the dev/demo mailbox, never reached the council. */
  email_mode: 'capture' | 'live' | null;
  authority_gss: string | null;
  police_force_id: string | null;
  authorities: { name: string; website: string | null } | null;
  police_forces: { name: string; report_url: string | null } | null;
};

export function deliveryTargetName(d: Delivery) {
  return d.authorities?.name ?? d.police_forces?.name ?? 'the council';
}

/**
 * Where the report went. RLS only returns rows to the report's owner, so this is
 * empty for everyone else. Routing runs just after submit, so poll briefly until
 * deliveries appear.
 */
export function useDeliveries(reportId: string, createdAt?: string) {
  return useQuery({
    queryKey: ['deliveries', reportId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('deliveries')
        .select(
          'id, channel, status, recipient, external_ref, sent_at, email_subject, email_text, email_mode, authority_gss, police_force_id, authorities(name, website), police_forces(name, report_url)'
        )
        .eq('report_id', reportId)
        .order('id');
      if (error) throw error;
      return data as unknown as Delivery[];
    },
    refetchInterval: (q) => {
      const young = createdAt && Date.now() - new Date(createdAt).getTime() < 60_000;
      return young && !q.state.data?.length ? 2000 : false;
    },
  });
}

export function useMarkSubmitted(reportId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ deliveryId, externalRef }: { deliveryId: number; externalRef?: string }) => {
      const { error } = await supabase.rpc('mark_delivery_submitted', {
        delivery_id: deliveryId,
        external_ref: externalRef || null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['deliveries', reportId] });
      qc.invalidateQueries({ queryKey: ['report', reportId] });
      qc.invalidateQueries({ queryKey: ['my_reports'] });
    },
  });
}
