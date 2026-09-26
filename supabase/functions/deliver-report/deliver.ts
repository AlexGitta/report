// Core of the deliver-report Edge Function (PLAN §5 "Delivery", §6 "Tracking"). No HTTP, no env:
// all I/O comes in through DeliverDeps so it can be tested with fakes.
//
// - email deliveries  -> send via EmailSender; 'sent' + sent_at + provider_message_id, or 'failed' + error
// - signpost          -> 'needs_user' (recipient already holds the URL the user must submit on)
// - open311           -> left alone (not implemented yet)
// Only deliveries in 'pending' or 'failed' are touched, so re-running is safe.

import type { EmailSender } from "../_shared/email/types.ts";
import { parsePoint } from "../route-report/location.ts";
import { composeReportEmail, type PhotoLink, replyAddress } from "./compose.ts";
import type { DeliveryRepo, DeliveryRow, DeliveryStatus, PhotoRow } from "./repo.ts";

export const DEFAULT_REPLY_DOMAIN = "reports.localhost";
export const PHOTO_LINK_DAYS = 30;
export const PHOTO_LINK_TTL_SECONDS = PHOTO_LINK_DAYS * 24 * 60 * 60;

/** Report statuses from which delivery may run. */
export const DELIVERABLE_STATUSES = ["submitted", "sent", "acknowledged", "in_progress"];
const RETRYABLE_DELIVERY_STATUSES: DeliveryStatus[] = ["pending", "failed"];

export interface DeliverConfig {
  /** From header, e.g. `Local Problem Reporter <no-reply@reports.example>`. */
  emailFrom: string;
  /** Domain for the reply-to address `reply+<ref>@<domain>`. */
  replyDomain: string;
  /** Recorded on each sent delivery so the app can say "captured, not delivered". */
  emailMode?: "capture" | "live";
}

export interface DeliverDeps {
  repo: DeliveryRepo;
  /** Lazily created so a signpost-only run never needs email config. */
  email: () => EmailSender;
  config: DeliverConfig;
  now?: () => Date;
}

export interface DeliverOptions {
  /** Deliver even if the report is flagged needs_moderation (moderator approved it). */
  force?: boolean;
}

export interface DeliveryResult {
  id: number;
  channel: DeliveryRow["channel"];
  authority_gss: string | null;
  police_force_id: string | null;
  name: string | null;
  recipient: string | null;
  /** Status after this run. */
  status: DeliveryStatus;
  /** What this run did with it. */
  action: "sent" | "failed" | "needs_user" | "skipped";
  error?: string;
}

export type DeliverOutcome =
  | {
    kind: "processed";
    reportId: string;
    reportStatus: string;
    deliveries: DeliveryResult[];
    /** Signpost deliveries the user still needs to act on (any run, not just this one). */
    needsUser: DeliveryResult[];
    sent: number;
    failed: number;
    /** Emails left pending because the report awaits moderation. */
    heldForModeration: boolean;
  }
  | { kind: "not_found"; reportId: string; what: "report" | "category" }
  | { kind: "skipped"; reportId: string; reason: string };

export function defaultEmailFrom(replyDomain: string): string {
  return `Local Problem Reporter <no-reply@${replyDomain}>`;
}

/** Private photos (may show people / number plates) are only linked once a moderator made them public. */
export function isPhotoShareable(p: PhotoRow): boolean {
  if (p.is_public) return true;
  return p.contains_people !== true && p.contains_plates !== true;
}

export async function deliverReport(
  reportId: string,
  deps: DeliverDeps,
  opts: DeliverOptions = {},
): Promise<DeliverOutcome> {
  const { repo } = deps;
  const now = deps.now ?? (() => new Date());

  const report = await repo.getReport(reportId);
  if (!report) return { kind: "not_found", reportId, what: "report" };
  if (!DELIVERABLE_STATUSES.includes(report.status)) {
    return { kind: "skipped", reportId, reason: `status is '${report.status}'` };
  }
  if (report.is_hidden) return { kind: "skipped", reportId, reason: "report is hidden" };
  // Flagged content never reaches a council inbox until a moderator approves it (force),
  // but signposts are the reporter's own action, so they aren't held.
  const heldForModeration = report.needs_moderation && !opts.force;

  const category = await repo.getCategory(report.category_id);
  if (!category) return { kind: "not_found", reportId, what: "category" };

  const all = await repo.getDeliveries(reportId);
  const todo = all.filter((d) =>
    RETRYABLE_DELIVERY_STATUSES.includes(d.status) &&
    (d.channel === "signpost" || (d.channel === "email" && !heldForModeration))
  );

  const results: DeliveryResult[] = [];
  const resultOf = (
    d: DeliveryRow,
    action: DeliveryResult["action"],
    status: DeliveryStatus,
    error?: string,
  ) => {
    const r: DeliveryResult = {
      id: d.id,
      channel: d.channel,
      authority_gss: d.authority_gss,
      police_force_id: d.police_force_id,
      name: d.target_name,
      recipient: d.recipient,
      status,
      action,
    };
    if (error) r.error = error;
    return r;
  };

  // Email content is the same for every recipient apart from the greeting: build lazily.
  let emailBase: Awaited<ReturnType<typeof loadEmailBase>> | null = null;
  const getEmailBase = async () => (emailBase ??= await loadEmailBase());
  async function loadEmailBase() {
    const photos = await repo.getPhotos(reportId);
    const shareable = photos.filter(isPhotoShareable);
    const links: PhotoLink[] = [];
    let unsigned = 0;
    for (const p of shareable) {
      const url = await repo.signPhotoUrl(p.storage_path, PHOTO_LINK_TTL_SECONDS);
      if (url) links.push({ url });
      else unsigned++;
    }
    if (unsigned > 0) console.warn(`deliver-report: ${unsigned} photo(s) could not be signed`);
    return { links, withheld: photos.length - shareable.length };
  }

  const newlySent: DeliveryRow[] = [];
  const newlyNeedsUser: DeliveryRow[] = [];

  for (const d of todo) {
    if (d.channel === "email") {
      const base = await getEmailBase();
      if (!(await repo.claimDelivery(d))) {
        results.push(resultOf(d, "skipped", d.status, "being processed by another run"));
        continue;
      }
      const to = d.recipient?.trim();
      if (!to) {
        const error = "no recipient email address";
        await repo.updateDelivery(d.id, { status: "failed", error });
        results.push(resultOf(d, "failed", "failed", error));
        continue;
      }
      const replyTo = replyAddress(report.ref, deps.config.replyDomain);
      const email = composeReportEmail({
        report,
        category,
        point: parsePoint(report.location),
        recipientName: d.target_name,
        photos: base.links,
        withheldPhotos: base.withheld,
        replyTo,
        photoLinkDays: PHOTO_LINK_DAYS,
      });
      try {
        const res = await deps.email().send({
          from: deps.config.emailFrom,
          to: [to],
          replyTo,
          subject: email.subject,
          text: email.text,
          html: email.html,
          headers: { "X-Report-Ref": report.ref, "X-Delivery-Id": String(d.id) },
        });
        await repo.updateDelivery(d.id, {
          status: "sent",
          sent_at: now().toISOString(),
          provider_message_id: res.messageId,
          error: null,
          email_subject: email.subject,
          email_text: email.text,
          email_mode: deps.config.emailMode ?? "capture",
        });
        newlySent.push(d);
        results.push(resultOf(d, "sent", "sent"));
      } catch (err) {
        const error = truncate((err as { message?: string })?.message ?? String(err), 1000);
        console.error(`deliver-report: delivery ${d.id} failed: ${error}`);
        await repo.updateDelivery(d.id, { status: "failed", error });
        results.push(resultOf(d, "failed", "failed", error));
      }
    } else {
      if (!(await repo.claimDelivery(d))) {
        results.push(resultOf(d, "skipped", d.status, "being processed by another run"));
        continue;
      }
      await repo.updateDelivery(d.id, { status: "needs_user", error: null });
      newlyNeedsUser.push(d);
      results.push(resultOf(d, "needs_user", "needs_user"));
    }
  }

  let reportStatus = report.status;
  if (newlySent.length > 0) {
    const names = joinNames(newlySent);
    if (await repo.markReportSent(reportId)) {
      reportStatus = "sent";
      await repo.addUpdate({
        reportId,
        kind: "status",
        statusTo: "sent",
        body: `Sent to ${names}`,
        isPublic: true,
      });
    } else {
      // Already sent to someone earlier (e.g. a retry of a failed delivery): just log it.
      await repo.addUpdate({
        reportId,
        kind: "comment",
        body: `Also sent to ${names}`,
        isPublic: true,
      });
    }
  }
  if (newlyNeedsUser.length > 0) {
    const names = joinNames(newlyNeedsUser);
    const forms = newlyNeedsUser.length === 1 ? "form" : "forms";
    await repo.addUpdate({
      reportId,
      kind: "comment",
      body: truncate(
        `Needs you to submit: ${names} ${
          newlyNeedsUser.length === 1 ? "does" : "do"
        } not accept reports from us by email. ` +
          `Please submit it using their online ${forms} (open the report in the app for the link and copy the pre-filled text).`,
        2000,
      ),
      // Instructions for the reporter; not part of the public timeline.
      isPublic: false,
    });
  }

  const byId = new Map(results.map((r) => [r.id, r]));
  const needsUser = all
    .filter((d) =>
      d.channel === "signpost" && (byId.get(d.id)?.status ?? d.status) === "needs_user"
    )
    .map((d) => byId.get(d.id) ?? resultOf(d, "skipped", d.status));

  return {
    kind: "processed",
    reportId,
    reportStatus,
    deliveries: results,
    needsUser,
    sent: results.filter((r) => r.action === "sent").length,
    failed: results.filter((r) => r.action === "failed").length,
    heldForModeration,
  };
}

function joinNames(ds: DeliveryRow[]): string {
  const names = [
    ...new Set(
      ds.map((d) => d.target_name ?? d.authority_gss ?? d.police_force_id ?? "the authority"),
    ),
  ];
  if (names.length <= 1) return names[0] ?? "the authority";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}
