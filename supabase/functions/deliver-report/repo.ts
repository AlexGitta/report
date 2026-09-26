// DB + storage access for deliver-report, behind an interface so the delivery logic can be unit
// tested with an in-memory fake. The Supabase implementation uses the service-role client.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export const PHOTO_BUCKET = "report-photos";

export interface DeliveryReportRow {
  id: string;
  ref: string;
  category_id: string | number;
  status: string;
  /** geography(Point,4326) as returned by PostgREST (hex EWKB), GeoJSON or WKT. */
  location: unknown;
  address_text: string | null;
  description: string | null;
  severity: string | null;
  extra: Record<string, unknown> | null;
  guest_name: string | null;
  guest_email: string | null;
  guest_phone: string | null;
  is_hidden: boolean;
  needs_moderation: boolean;
  created_at: string;
}

export interface ExtraFieldDef {
  key: string;
  label?: string;
  type?: string;
}

export interface DeliveryCategoryRow {
  id: string | number;
  slug: string;
  name: string;
  category_group: string | null;
  extra_fields: ExtraFieldDef[] | null;
}

export interface PhotoRow {
  id: string;
  storage_path: string;
  is_public: boolean;
  contains_people: boolean | null;
  contains_plates: boolean | null;
  sort_order: number;
}

export type DeliveryStatus =
  | "pending"
  | "sent"
  | "delivered"
  | "needs_user"
  | "failed"
  | "bounced";

export interface DeliveryRow {
  id: number;
  report_id: string;
  authority_gss: string | null;
  police_force_id: string | null;
  channel: "email" | "signpost" | "open311";
  status: DeliveryStatus;
  /** Email address (email channel) or signpost URL (signpost channel). */
  recipient: string | null;
  error: string | null;
  sent_at: string | null;
  /** Used as an optimistic-lock token by claimDelivery. */
  updated_at: string;
  /** authorities.name or police_forces.name (joined). */
  target_name: string | null;
}

export interface DeliveryPatch {
  status: DeliveryStatus;
  sent_at?: string | null;
  provider_message_id?: string | null;
  error?: string | null;
  email_subject?: string | null;
  email_text?: string | null;
  email_mode?: "capture" | "live" | null;
}

export interface NewReportUpdate {
  reportId: string;
  kind: "status" | "comment";
  statusTo?: "sent";
  body: string;
  isPublic: boolean;
}

export interface DeliveryRepo {
  getReport(id: string): Promise<DeliveryReportRow | null>;
  getCategory(id: string | number): Promise<DeliveryCategoryRow | null>;
  getPhotos(reportId: string): Promise<PhotoRow[]>;
  /** All deliveries of the report (any status), oldest first. */
  getDeliveries(reportId: string): Promise<DeliveryRow[]>;
  /**
   * Take a delivery for processing: succeeds only if it is still in the status/updated_at we
   * read (so two concurrent runs can't both send it). Returns false if someone else got it.
   */
  claimDelivery(d: DeliveryRow): Promise<boolean>;
  updateDelivery(id: number, patch: DeliveryPatch): Promise<void>;
  /** Signed URL for an object in the report-photos bucket, or null if it can't be signed. */
  signPhotoUrl(path: string, expiresInSeconds: number): Promise<string | null>;
  /** status 'submitted' -> 'sent'. Returns false (no change) if the report was not 'submitted'. */
  markReportSent(reportId: string): Promise<boolean>;
  addUpdate(u: NewReportUpdate): Promise<void>;
}

export class RepoError extends Error {
  constructor(op: string, cause: unknown) {
    const msg = (cause as { message?: string })?.message ?? String(cause);
    super(`db ${op} failed: ${msg}`, { cause });
    this.name = "RepoError";
  }
}

// deno-lint-ignore no-explicit-any
type AnyClient = SupabaseClient<any, any, any>;

export class SupabaseDeliveryRepo implements DeliveryRepo {
  constructor(private readonly db: AnyClient) {}

  async getReport(id: string): Promise<DeliveryReportRow | null> {
    const { data, error } = await this.db
      .from("reports")
      .select(
        "id, ref, category_id, status, location, address_text, description, severity, extra, " +
          "guest_name, guest_email, guest_phone, is_hidden, needs_moderation, created_at",
      )
      .eq("id", id)
      .maybeSingle();
    if (error) throw new RepoError("getReport", error);
    return data as DeliveryReportRow | null;
  }

  async getCategory(id: string | number): Promise<DeliveryCategoryRow | null> {
    const { data, error } = await this.db
      .from("categories")
      .select("id, slug, name, category_group, extra_fields")
      .eq("id", id)
      .maybeSingle();
    if (error) throw new RepoError("getCategory", error);
    return data as DeliveryCategoryRow | null;
  }

  async getPhotos(reportId: string): Promise<PhotoRow[]> {
    const { data, error } = await this.db
      .from("report_photos")
      .select("id, storage_path, is_public, contains_people, contains_plates, sort_order")
      .eq("report_id", reportId)
      .order("sort_order")
      .order("created_at");
    if (error) throw new RepoError("getPhotos", error);
    return (data ?? []) as PhotoRow[];
  }

  async getDeliveries(reportId: string): Promise<DeliveryRow[]> {
    const { data, error } = await this.db
      .from("deliveries")
      .select(
        "id, report_id, authority_gss, police_force_id, channel, status, recipient, error, " +
          "sent_at, updated_at, authority:authorities(name), police_force:police_forces(name)",
      )
      .eq("report_id", reportId)
      .order("id");
    if (error) throw new RepoError("getDeliveries", error);
    type Raw = Omit<DeliveryRow, "target_name"> & {
      authority: { name: string } | null;
      police_force: { name: string } | null;
    };
    return ((data ?? []) as unknown as Raw[]).map(({ authority, police_force, ...rest }) => ({
      ...rest,
      target_name: authority?.name ?? police_force?.name ?? null,
    }));
  }

  async claimDelivery(d: DeliveryRow): Promise<boolean> {
    // Touching the row bumps updated_at (trigger), so a second claimer with the same token loses.
    const { data, error } = await this.db
      .from("deliveries")
      .update({ status: d.status })
      .eq("id", d.id)
      .eq("status", d.status)
      .eq("updated_at", d.updated_at)
      .select("id");
    if (error) throw new RepoError("claimDelivery", error);
    return (data ?? []).length === 1;
  }

  async updateDelivery(id: number, patch: DeliveryPatch): Promise<void> {
    const { error } = await this.db.from("deliveries").update(patch).eq("id", id);
    if (error) throw new RepoError("updateDelivery", error);
  }

  async signPhotoUrl(path: string, expiresInSeconds: number): Promise<string | null> {
    const { data, error } = await this.db.storage
      .from(PHOTO_BUCKET)
      .createSignedUrl(path, expiresInSeconds);
    if (error) {
      console.warn(`deliver-report: could not sign ${path}: ${error.message}`);
      return null;
    }
    return data?.signedUrl ?? null;
  }

  async markReportSent(reportId: string): Promise<boolean> {
    const { data, error } = await this.db
      .from("reports")
      .update({ status: "sent" })
      .eq("id", reportId)
      .eq("status", "submitted")
      .select("id");
    if (error) throw new RepoError("markReportSent", error);
    return (data ?? []).length === 1;
  }

  async addUpdate(u: NewReportUpdate): Promise<void> {
    const { error } = await this.db.from("report_updates").insert({
      report_id: u.reportId,
      actor_type: "system",
      actor_id: null,
      kind: u.kind,
      status_to: u.statusTo ?? null,
      body: u.body,
      is_public: u.isPublic,
    });
    if (error) throw new RepoError("insert report_updates", error);
  }
}
