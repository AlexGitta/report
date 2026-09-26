// Builds the email a council receives for a report (PLAN §5 "Delivery"). Pure: no I/O.

import type { LatLng } from "../route-report/location.ts";
import type { DeliveryCategoryRow, DeliveryReportRow } from "./repo.ts";

export const APP_NAME = "Local Problem Reporter";

export interface PhotoLink {
  url: string;
}

export interface ComposeInput {
  report: DeliveryReportRow;
  category: DeliveryCategoryRow;
  point: LatLng | null;
  /** Name of the authority the email goes to (for the greeting); null if unknown. */
  recipientName: string | null;
  photos: PhotoLink[];
  /** Photos not linked because they may show people / number plates (awaiting review). */
  withheldPhotos: number;
  replyTo: string;
  /** Days the photo links stay valid (for the note under them). */
  photoLinkDays: number;
}

export interface ComposedEmail {
  subject: string;
  text: string;
  html: string;
}

export function replyAddress(ref: string, domain: string): string {
  return `reply+${ref}@${domain}`;
}

export function osmUrl(p: LatLng): string {
  const lat = p.lat.toFixed(6);
  const lng = p.lng.toFixed(6);
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=18/${lat}/${lng}`;
}

export function formatLatLng(p: LatLng): string {
  return `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`;
}

/** e.g. "Saturday 26 September 2026 at 13:05" in UK time. */
export function formatReportedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  // formatToParts: ICU versions differ on punctuation ("Saturday, 26 ..." vs "Saturday 26 ...").
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/London",
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(d).map((p) => [p.type, p.value]),
  );
  return `${parts.weekday} ${parts.day} ${parts.month} ${parts.year} at ${parts.hour}:${parts.minute} (UK time)`;
}

function whereText(report: DeliveryReportRow, point: LatLng | null): string {
  const addr = report.address_text?.trim();
  if (addr) return addr;
  if (point) return formatLatLng(point);
  return "an unknown location";
}

function extraValueText(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map((x) => extraValueText(x)).filter(Boolean).join(", ") || null;
  return JSON.stringify(v);
}

/** [label, value] pairs for reports.extra, in the order the category defines its fields. */
export function extraFieldRows(
  category: DeliveryCategoryRow,
  extra: Record<string, unknown> | null,
): [string, string][] {
  if (!extra) return [];
  const defs = Array.isArray(category.extra_fields) ? category.extra_fields : [];
  const rows: [string, string][] = [];
  const seen = new Set<string>();
  for (const def of defs) {
    if (!def?.key) continue;
    seen.add(def.key);
    const v = extraValueText(extra[def.key]);
    if (v) rows.push([def.label?.trim() || def.key, v]);
  }
  for (const [k, raw] of Object.entries(extra)) {
    if (seen.has(k)) continue;
    const v = extraValueText(raw);
    if (v) rows.push([k, v]);
  }
  return rows;
}

/** Reporter contact details, only those present on the report row. */
export function reporterRows(report: DeliveryReportRow): [string, string][] {
  const rows: [string, string][] = [];
  const name = report.guest_name?.trim();
  const email = report.guest_email?.trim();
  const phone = report.guest_phone?.trim();
  if (name) rows.push(["Name", name]);
  if (email) rows.push(["Email", email]);
  if (phone) rows.push(["Phone", phone]);
  return rows;
}

export function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function composeReportEmail(input: ComposeInput): ComposedEmail {
  const { report, category, point, photos } = input;
  const where = whereText(report, point);
  const subject = oneLine(`[${report.ref}] ${category.name} reported at ${where}`, 200);

  const details: [string, string][] = [["Problem", category.name]];
  if (report.severity) details.push(["Severity (reporter's view)", report.severity]);
  details.push(...extraFieldRows(category, report.extra));
  details.push(["Reported", formatReportedAt(report.created_at)]);
  details.push(["Reference", report.ref]);

  const location: [string, string][] = [];
  if (report.address_text?.trim()) {
    location.push(["Address / description", report.address_text.trim()]);
  }
  if (point) {
    location.push(["Latitude, longitude", formatLatLng(point)]);
    location.push(["Map", osmUrl(point)]);
  }
  const contact = reporterRows(report);
  const description = report.description?.trim() || "";
  const photoNote = `Photo links are valid for ${input.photoLinkDays} days.`;
  const withheldNote = input.withheldPhotos > 0
    ? `${input.withheldPhotos} further photo${
      input.withheldPhotos === 1 ? " is" : "s are"
    } being held back while we check for faces or number plates.`
    : "";
  const footer = [
    `This report was sent by ${APP_NAME}, an independent app, on behalf of a resident.`,
    `We are not part of the council. Please reply to this email (${input.replyTo}) with any`,
    `updates or questions and quote reference ${report.ref}; we pass replies on to the resident`,
    `and show progress on the report's public page.`,
  ].join(" ");

  // ---- plain text
  const t: string[] = [];
  t.push(input.recipientName ? `To: ${input.recipientName}` : "Hello,", "");
  t.push(`A resident has reported a problem: ${category.name} at ${where}.`, "");
  t.push("DETAILS", ...kv(details), "");
  if (description) t.push("DESCRIPTION", description, "");
  t.push("LOCATION", ...(location.length ? kv(location) : ["Not provided"]), "");
  if (photos.length > 0 || withheldNote) {
    t.push("PHOTOS");
    photos.forEach((p, i) => t.push(`Photo ${i + 1}: ${p.url}`));
    if (photos.length > 0) t.push(photoNote);
    if (withheldNote) t.push(withheldNote);
    t.push("");
  }
  if (contact.length > 0) {
    t.push("REPORTER CONTACT (for follow-up only, please do not publish)", ...kv(contact), "");
  }
  t.push("--", footer);
  const text = t.join("\n");

  // ---- HTML
  const h: string[] = [];
  h.push(
    `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.45;color:#1b1b1b;max-width:640px">`,
  );
  h.push(
    `<p>${
      input.recipientName ? `To: <strong>${escapeHtml(input.recipientName)}</strong>` : "Hello,"
    }</p>`,
  );
  h.push(
    `<p>A resident has reported a problem: <strong>${escapeHtml(category.name)}</strong> at ${
      escapeHtml(where)
    }.</p>`,
  );
  h.push(section("Details"), table(details));
  if (description) {
    h.push(
      section("Description"),
      `<p style="white-space:pre-wrap">${escapeHtml(description)}</p>`,
    );
  }
  h.push(section("Location"));
  if (location.length === 0) h.push("<p>Not provided</p>");
  else {
    h.push(table(location.filter(([k]) => k !== "Map")));
    if (point) {
      h.push(
        `<p><a href="${escapeHtml(osmUrl(point))}">View on OpenStreetMap</a></p>`,
      );
    }
  }
  if (photos.length > 0 || withheldNote) {
    h.push(section("Photos"));
    if (photos.length > 0) {
      h.push(
        "<p>" +
          photos.map((p, i) =>
            `<a href="${escapeHtml(p.url)}"><img src="${escapeHtml(p.url)}" alt="Photo ${
              i + 1
            }" width="300" style="max-width:100%;margin:0 8px 8px 0;border:1px solid #ccc"></a>`
          ).join("") + "</p>",
      );
      h.push(
        "<p>" + photos.map((p, i) => `<a href="${escapeHtml(p.url)}">Photo ${i + 1}</a>`).join(
          " &middot; ",
        ) + ` <small>(${escapeHtml(photoNote)})</small></p>`,
      );
    }
    if (withheldNote) h.push(`<p><small>${escapeHtml(withheldNote)}</small></p>`);
  }
  if (contact.length > 0) {
    h.push(section("Reporter contact"));
    h.push("<p><small>For follow-up only, please do not publish.</small></p>", table(contact));
  }
  h.push(
    `<hr style="border:none;border-top:1px solid #ccc;margin-top:24px"><p style="font-size:13px;color:#555">${
      escapeHtml(footer)
    }</p>`,
  );
  h.push("</body></html>");

  return { subject, text, html: h.join("\n") };
}

function kv(rows: [string, string][]): string[] {
  return rows.map(([k, v]) => `${k}: ${v}`);
}

function section(title: string): string {
  return `<h3 style="margin:20px 0 6px;font-size:16px">${escapeHtml(title)}</h3>`;
}

function table(rows: [string, string][]): string {
  return `<table cellpadding="4" style="border-collapse:collapse">` +
    rows.map(([k, v]) =>
      `<tr><td style="color:#555;vertical-align:top;padding-right:12px">${escapeHtml(k)}</td><td>${
        escapeHtml(v)
      }</td></tr>`
    ).join("") +
    `</table>`;
}

function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}
