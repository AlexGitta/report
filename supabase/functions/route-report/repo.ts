// DB access for route-report, behind a small interface so the routing logic can be unit tested
// with an in-memory fake. The Supabase implementation uses the service-role client.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export interface ReportRow {
  id: string;
  category_id: string | number;
  status: string;
  /** geography(Point,4326) as returned by PostgREST (hex EWKB), GeoJSON or WKT. */
  location: unknown;
}

export interface CategoryRow {
  id: string | number;
  slug: string;
  category_group: string | null;
  routing_target: string;
}

export interface AuthorityRow {
  gss_code: string;
  name: string;
  type: string;
  parent_gss: string | null;
  website?: string | null;
}

export interface ContactRow {
  authority_gss: string;
  /** null = applies to all groups. */
  category_group: string | null;
  /** Optional finer override for one category. */
  category_id: string | number | null;
  email: string | null;
  form_url: string | null;
  /** Higher wins among equally specific matches (hand-verified links beat GOV.UK ones). */
  priority?: number | null;
}

export interface PoliceForceRow {
  id: string;
  name: string;
  report_url: string | null;
  non_emergency_url: string | null;
}

export type DeliveryChannel = "email" | "signpost";

export interface NewDelivery {
  report_id: string;
  authority_gss: string | null;
  police_force_id: string | null;
  channel: DeliveryChannel;
  status: "pending";
  /** Email address (email channel) or signpost URL (signpost channel). */
  recipient: string | null;
}

export interface RoutingUpdate {
  reportId: string;
  routedAuthorities: string[];
  policeForceId: string | null;
  policeNeighbourhood: string | null;
  deliveries: NewDelivery[];
}

export interface UnroutedUpdate {
  reportId: string;
  reason: string;
  message: string;
  policeForceId: string | null;
  policeNeighbourhood: string | null;
}

export interface RoutingRepo {
  getReport(id: string): Promise<ReportRow | null>;
  getCategory(id: string | number): Promise<CategoryRow | null>;
  getAuthorities(gss: string[]): Promise<AuthorityRow[]>;
  /** Insert authorities that are not there yet; never overwrites existing rows. */
  ensureAuthorities(rows: Omit<AuthorityRow, "website">[]): Promise<void>;
  getContacts(gss: string[]): Promise<ContactRow[]>;
  getPoliceForce(id: string): Promise<PoliceForceRow | null>;
  /** Snapshot routing onto the report and replace its pending deliveries. */
  saveRouting(update: RoutingUpdate): Promise<void>;
  /** Set status 'unrouted' + needs_moderation, clear pending deliveries, add a timeline row. */
  markUnrouted(update: UnroutedUpdate): Promise<void>;
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

export class SupabaseRoutingRepo implements RoutingRepo {
  constructor(private readonly db: AnyClient) {}

  async getReport(id: string): Promise<ReportRow | null> {
    const { data, error } = await this.db
      .from("reports")
      .select("id, category_id, status, location")
      .eq("id", id)
      .maybeSingle();
    if (error) throw new RepoError("getReport", error);
    return data as ReportRow | null;
  }

  async getCategory(id: string | number): Promise<CategoryRow | null> {
    const { data, error } = await this.db
      .from("categories")
      .select("id, slug, category_group, routing_target")
      .eq("id", id)
      .maybeSingle();
    if (error) throw new RepoError("getCategory", error);
    return data as CategoryRow | null;
  }

  async getAuthorities(gss: string[]): Promise<AuthorityRow[]> {
    if (gss.length === 0) return [];
    const { data, error } = await this.db
      .from("authorities")
      .select("*")
      .in("gss_code", gss);
    if (error) throw new RepoError("getAuthorities", error);
    return (data ?? []) as AuthorityRow[];
  }

  async ensureAuthorities(rows: Omit<AuthorityRow, "website">[]): Promise<void> {
    if (rows.length === 0) return;
    const { error } = await this.db
      .from("authorities")
      .upsert(rows, { onConflict: "gss_code", ignoreDuplicates: true });
    if (error) throw new RepoError("ensureAuthorities", error);
  }

  async getContacts(gss: string[]): Promise<ContactRow[]> {
    if (gss.length === 0) return [];
    const { data, error } = await this.db
      .from("authority_contacts")
      .select("authority_gss, category_group, category_id, email, form_url, priority")
      .in("authority_gss", gss);
    if (error) throw new RepoError("getContacts", error);
    return (data ?? []) as ContactRow[];
  }

  async getPoliceForce(id: string): Promise<PoliceForceRow | null> {
    const { data, error } = await this.db
      .from("police_forces")
      .select("id, name, report_url, non_emergency_url")
      .eq("id", id)
      .maybeSingle();
    if (error) throw new RepoError("getPoliceForce", error);
    return data as PoliceForceRow | null;
  }

  async saveRouting(u: RoutingUpdate): Promise<void> {
    // Not transactional via PostgREST; order chosen so a failure leaves a re-runnable state.
    await this.clearPendingDeliveries(u.reportId);
    if (u.deliveries.length > 0) {
      const { error } = await this.db.from("deliveries").insert(u.deliveries);
      if (error) throw new RepoError("insert deliveries", error);
    }
    const { error } = await this.db
      .from("reports")
      .update({
        routed_authorities: u.routedAuthorities,
        police_force_id: u.policeForceId,
        police_neighbourhood: u.policeNeighbourhood,
      })
      .eq("id", u.reportId);
    if (error) throw new RepoError("update report", error);
  }

  async markUnrouted(u: UnroutedUpdate): Promise<void> {
    await this.clearPendingDeliveries(u.reportId);
    const { error } = await this.db
      .from("reports")
      .update({
        status: "unrouted",
        needs_moderation: true,
        routed_authorities: [],
        police_force_id: u.policeForceId,
        police_neighbourhood: u.policeNeighbourhood,
      })
      .eq("id", u.reportId);
    if (error) throw new RepoError("update report (unrouted)", error);
    const { error: e2 } = await this.db.from("report_updates").insert({
      report_id: u.reportId,
      actor_type: "system",
      actor_id: null,
      kind: "status",
      status_to: "unrouted",
      body: `${u.message} (${u.reason})`,
    });
    if (e2) throw new RepoError("insert report_updates", e2);
  }

  private async clearPendingDeliveries(reportId: string): Promise<void> {
    const { error } = await this.db
      .from("deliveries")
      .delete()
      .eq("report_id", reportId)
      .eq("status", "pending");
    if (error) throw new RepoError("clear pending deliveries", error);
  }
}
