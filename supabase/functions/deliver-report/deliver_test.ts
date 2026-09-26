import { assert, assertEquals, assertFalse, assertStringIncludes } from "jsr:@std/assert@1";
import type { EmailMessage, EmailSender, SendResult } from "../_shared/email/types.ts";
import { EmailSendError } from "../_shared/email/types.ts";
import { deliverViaFunction } from "../route-report/handler.ts";
import {
  type DeliverDeps,
  deliverReport,
  isPhotoShareable,
  PHOTO_LINK_TTL_SECONDS,
} from "./deliver.ts";
import { createHandler } from "./handler.ts";
import type {
  DeliveryCategoryRow,
  DeliveryPatch,
  DeliveryRepo,
  DeliveryReportRow,
  DeliveryRow,
  NewReportUpdate,
  PhotoRow,
} from "./repo.ts";

// ---------------------------------------------------------------- fakes

class FakeRepo implements DeliveryRepo {
  reports = new Map<string, DeliveryReportRow>();
  categories = new Map<string, DeliveryCategoryRow>();
  photos: (PhotoRow & { report_id: string })[] = [];
  deliveries: DeliveryRow[] = [];
  updates: NewReportUpdate[] = [];
  signed: { path: string; ttl: number }[] = [];
  patches: { id: number; patch: DeliveryPatch }[] = [];
  /** ids whose claim should fail (simulates a concurrent run). */
  claimFails = new Set<number>();
  private tick = 0;

  getReport(id: string) {
    return Promise.resolve(this.reports.get(id) ?? null);
  }
  getCategory(id: string | number) {
    return Promise.resolve(this.categories.get(String(id)) ?? null);
  }
  getPhotos(reportId: string) {
    return Promise.resolve(this.photos.filter((p) => p.report_id === reportId));
  }
  getDeliveries(reportId: string) {
    return Promise.resolve(
      this.deliveries.filter((d) => d.report_id === reportId).map((d) => ({ ...d })),
    );
  }
  claimDelivery(d: DeliveryRow) {
    const row = this.deliveries.find((x) => x.id === d.id);
    if (!row || this.claimFails.has(d.id)) return Promise.resolve(false);
    if (row.status !== d.status || row.updated_at !== d.updated_at) return Promise.resolve(false);
    row.updated_at = `t${++this.tick}`;
    return Promise.resolve(true);
  }
  updateDelivery(id: number, patch: DeliveryPatch) {
    this.patches.push({ id, patch });
    const row = this.deliveries.find((x) => x.id === id)!;
    Object.assign(row, patch, { updated_at: `t${++this.tick}` });
    return Promise.resolve();
  }
  signPhotoUrl(path: string, ttl: number) {
    this.signed.push({ path, ttl });
    return Promise.resolve(`https://storage.test/sign/report-photos/${path}?token=abc`);
  }
  markReportSent(reportId: string) {
    const r = this.reports.get(reportId)!;
    if (r.status !== "submitted") return Promise.resolve(false);
    r.status = "sent";
    return Promise.resolve(true);
  }
  addUpdate(u: NewReportUpdate) {
    this.updates.push(u);
    return Promise.resolve();
  }
}

class FakeSender implements EmailSender {
  readonly provider = "fake";
  sent: EmailMessage[] = [];
  failFor = new Set<string>();
  send(msg: EmailMessage): Promise<SendResult> {
    if (msg.to.some((t) => this.failFor.has(t))) {
      return Promise.reject(new EmailSendError("fake", "550 mailbox unavailable", false));
    }
    this.sent.push(msg);
    return Promise.resolve({ messageId: `<msg-${this.sent.length}@fake>`, provider: "fake" });
  }
}

const REPORT_ID = "11111111-1111-1111-1111-111111111111";

function baseReport(over: Partial<DeliveryReportRow> = {}): DeliveryReportRow {
  return {
    id: REPORT_ID,
    ref: "RPT-7K3M9Q",
    category_id: 1,
    status: "submitted",
    location: "SRID=4326;POINT(0.521500 51.272100)",
    address_text: "Week Street, Maidstone",
    description: "Deep pothole in the nearside lane.",
    severity: "high",
    extra: {},
    guest_name: null,
    guest_email: null,
    guest_phone: null,
    is_hidden: false,
    needs_moderation: false,
    created_at: "2026-09-26T12:05:00Z",
    ...over,
  };
}

const CATS: DeliveryCategoryRow[] = [
  { id: 1, slug: "pothole", name: "Pothole", category_group: "roads", extra_fields: [] },
  {
    id: 4,
    slug: "asb",
    name: "Anti-social behaviour",
    category_group: "community_safety",
    extra_fields: [],
  },
  {
    id: 7,
    slug: "abandoned_vehicle",
    name: "Abandoned vehicle",
    category_group: "street_scene",
    extra_fields: [
      { key: "registration", label: "Registration number", type: "text" },
      { key: "colour", label: "Colour", type: "text" },
    ],
  },
];

let nextId = 1;
function delivery(over: Partial<DeliveryRow>): DeliveryRow {
  return {
    id: nextId++,
    report_id: REPORT_ID,
    authority_gss: "E10000016",
    police_force_id: null,
    channel: "email",
    status: "pending",
    recipient: "highways@kent.test",
    error: null,
    sent_at: null,
    updated_at: "t0",
    target_name: "Kent County Council",
    ...over,
  };
}

function setup(report = baseReport(), deliveries: Partial<DeliveryRow>[] = [{}]) {
  const repo = new FakeRepo();
  repo.reports.set(report.id, report);
  for (const c of CATS) repo.categories.set(String(c.id), c);
  repo.deliveries = deliveries.map(delivery);
  const sender = new FakeSender();
  let senderCreated = 0;
  const deps: DeliverDeps = {
    repo,
    email: () => {
      senderCreated++;
      return sender;
    },
    config: {
      emailFrom: "Local Problem Reporter <no-reply@reports.localhost>",
      replyDomain: "reports.localhost",
    },
    now: () => new Date("2026-09-26T12:10:00Z"),
  };
  return { repo, sender, deps, senderCreated: () => senderCreated };
}

// ---------------------------------------------------------------- tests

Deno.test("email success: sends, marks delivery sent, report sent + status timeline row", async () => {
  const { repo, sender, deps } = setup();
  const out = await deliverReport(REPORT_ID, deps);
  assert(out.kind === "processed");
  assertEquals(out.sent, 1);
  assertEquals(out.failed, 0);
  assertEquals(out.reportStatus, "sent");

  assertEquals(sender.sent.length, 1);
  const msg = sender.sent[0];
  assertEquals(msg.to, ["highways@kent.test"]);
  assertEquals(msg.replyTo, "reply+RPT-7K3M9Q@reports.localhost");
  assertEquals(msg.subject, "[RPT-7K3M9Q] Pothole reported at Week Street, Maidstone");
  assertEquals(msg.headers?.["X-Report-Ref"], "RPT-7K3M9Q");
  assertStringIncludes(msg.text, "Deep pothole in the nearside lane.");
  assertStringIncludes(msg.text, "51.27210, 0.52150");
  assertStringIncludes(msg.text, "https://www.openstreetmap.org/?mlat=51.272100&mlon=0.521500");
  assertStringIncludes(msg.text, "Saturday 26 September 2026 at 13:05 (UK time)");
  assertStringIncludes(msg.text, "on behalf of a resident");
  assertStringIncludes(msg.html!, "View on OpenStreetMap");
  assertFalse(msg.text.includes("REPORTER CONTACT"));

  const d = repo.deliveries[0];
  assertEquals(d.status, "sent");
  assertEquals(d.sent_at, "2026-09-26T12:10:00.000Z");
  assertEquals(
    (d as unknown as { provider_message_id: string }).provider_message_id,
    "<msg-1@fake>",
  );
  assertEquals(repo.reports.get(REPORT_ID)!.status, "sent");
  assertEquals(repo.updates, [{
    reportId: REPORT_ID,
    kind: "status",
    statusTo: "sent",
    body: "Sent to Kent County Council",
    isPublic: true,
  }]);
});

Deno.test("email failure: delivery failed with error, report status unchanged, no timeline row", async () => {
  const { repo, sender, deps } = setup();
  sender.failFor.add("highways@kent.test");
  const out = await deliverReport(REPORT_ID, deps);
  assert(out.kind === "processed");
  assertEquals(out.failed, 1);
  assertEquals(out.sent, 0);
  assertEquals(repo.deliveries[0].status, "failed");
  assertStringIncludes(repo.deliveries[0].error!, "550 mailbox unavailable");
  assertEquals(repo.reports.get(REPORT_ID)!.status, "submitted");
  assertEquals(repo.updates, []);

  // Retry once the problem is fixed: failed deliveries are picked up again.
  sender.failFor.clear();
  const again = await deliverReport(REPORT_ID, deps);
  assert(again.kind === "processed");
  assertEquals(again.sent, 1);
  assertEquals(repo.deliveries[0].status, "sent");
  assertEquals(repo.deliveries[0].error, null);
  assertEquals(repo.reports.get(REPORT_ID)!.status, "sent");
});

Deno.test("email delivery without recipient fails without calling the sender", async () => {
  const { repo, sender, deps } = setup(baseReport(), [{ recipient: null }]);
  const out = await deliverReport(REPORT_ID, deps);
  assert(out.kind === "processed");
  assertEquals(out.failed, 1);
  assertEquals(sender.sent.length, 0);
  assertEquals(repo.deliveries[0].error, "no recipient email address");
});

Deno.test("signpost only: needs_user, status unchanged, private comment, no email sender created", async () => {
  const { repo, deps, senderCreated } = setup(baseReport(), [{
    channel: "signpost",
    recipient: "https://www.kent.gov.uk/report-a-pothole",
  }]);
  const out = await deliverReport(REPORT_ID, deps);
  assert(out.kind === "processed");
  assertEquals(senderCreated(), 0);
  assertEquals(repo.deliveries[0].status, "needs_user");
  assertEquals(repo.reports.get(REPORT_ID)!.status, "submitted");
  assertEquals(out.reportStatus, "submitted");
  assertEquals(out.needsUser.length, 1);
  assertEquals(out.needsUser[0].recipient, "https://www.kent.gov.uk/report-a-pothole");
  assertEquals(repo.updates.length, 1);
  assertEquals(repo.updates[0].kind, "comment");
  assertEquals(repo.updates[0].isPublic, false);
  assertStringIncludes(repo.updates[0].body, "Needs you to submit: Kent County Council");
  assertEquals(repo.photos.length, 0);
  assertEquals(repo.signed.length, 0);

  // Second run: nothing to do, no duplicate comment, needs_user still reported.
  const again = await deliverReport(REPORT_ID, deps);
  assert(again.kind === "processed");
  assertEquals(again.deliveries, []);
  assertEquals(again.needsUser.length, 1);
  assertEquals(repo.updates.length, 1);
});

Deno.test("mixed: one email sent, one signpost -> report sent, status row + needs-user comment", async () => {
  const { repo, sender, deps } = setup(baseReport(), [
    { authority_gss: "E10000016", target_name: "Kent County Council" },
    {
      authority_gss: "E07000110",
      target_name: "Maidstone Borough Council",
      channel: "signpost",
      recipient: "https://maidstone.test/report",
    },
  ]);
  const out = await deliverReport(REPORT_ID, deps);
  assert(out.kind === "processed");
  assertEquals(sender.sent.length, 1);
  assertEquals(repo.deliveries.map((d) => d.status), ["sent", "needs_user"]);
  assertEquals(repo.reports.get(REPORT_ID)!.status, "sent");
  assertEquals(repo.updates.map((u) => [u.kind, u.statusTo ?? null, u.isPublic]), [
    ["status", "sent", true],
    ["comment", null, false],
  ]);
  assertEquals(repo.updates[0].body, "Sent to Kent County Council");
  assertStringIncludes(repo.updates[1].body, "Maidstone Borough Council");
});

Deno.test("two emails: one sent, one failed -> report sent to the one that worked", async () => {
  const { repo, sender, deps } = setup(baseReport(), [
    { recipient: "a@kent.test", target_name: "Kent County Council" },
    {
      authority_gss: "E07000110",
      recipient: "b@maidstone.test",
      target_name: "Maidstone Borough Council",
    },
  ]);
  sender.failFor.add("b@maidstone.test");
  const out = await deliverReport(REPORT_ID, deps);
  assert(out.kind === "processed");
  assertEquals([out.sent, out.failed], [1, 1]);
  assertEquals(repo.updates[0].body, "Sent to Kent County Council");

  // Retry: only the failed one is sent; report already 'sent' -> "Also sent to" comment.
  sender.failFor.clear();
  const again = await deliverReport(REPORT_ID, deps);
  assert(again.kind === "processed");
  assertEquals(again.deliveries.map((d) => d.id), [repo.deliveries[1].id]);
  assertEquals(sender.sent.length, 2);
  assertEquals(repo.updates.length, 2);
  assertEquals(repo.updates[1], {
    reportId: REPORT_ID,
    kind: "comment",
    body: "Also sent to Maidstone Borough Council",
    isPublic: true,
  });
});

Deno.test("ASB: council gets email incl. reporter contact; police row is a signpost", async () => {
  const report = baseReport({
    category_id: 4,
    address_text: null,
    description: "Group of youths throwing stones at cars every evening.",
    guest_name: "Sam Resident",
    guest_email: "sam@example.test",
    guest_phone: "07700 900123",
  });
  const { repo, sender, deps } = setup(report, [
    {
      authority_gss: "E07000110",
      target_name: "Maidstone Borough Council",
      recipient: "asb@maidstone.test",
    },
    {
      authority_gss: null,
      police_force_id: "kent",
      target_name: "Kent Police",
      channel: "signpost",
      recipient: "https://www.kent.police.uk/ro/report/",
    },
  ]);
  const out = await deliverReport(REPORT_ID, deps);
  assert(out.kind === "processed");
  assertEquals(sender.sent.length, 1);
  const msg = sender.sent[0];
  assertEquals(msg.to, ["asb@maidstone.test"]);
  assertEquals(msg.subject, "[RPT-7K3M9Q] Anti-social behaviour reported at 51.27210, 0.52150");
  assertStringIncludes(msg.text, "REPORTER CONTACT");
  assertStringIncludes(msg.text, "Name: Sam Resident");
  assertStringIncludes(msg.text, "Email: sam@example.test");
  assertStringIncludes(msg.text, "Phone: 07700 900123");
  assertStringIncludes(msg.html!, "sam@example.test");

  const police = repo.deliveries[1];
  assertEquals(police.status, "needs_user");
  assertEquals(out.needsUser.map((d) => [d.police_force_id, d.recipient]), [
    ["kent", "https://www.kent.police.uk/ro/report/"],
  ]);
  // Public timeline row never contains the reporter's details.
  for (const u of repo.updates.filter((u) => u.isPublic)) {
    assertFalse(u.body.includes("Sam"));
    assertFalse(u.body.includes("sam@example.test"));
  }
  assertStringIncludes(repo.updates.find((u) => u.kind === "comment")!.body, "Kent Police");
});

Deno.test("idempotency: sent / needs_user deliveries are skipped, nothing re-sent", async () => {
  const { repo, sender, deps } = setup(baseReport({ status: "sent" }), [
    { status: "sent", sent_at: "2026-09-26T12:00:00Z" },
    { channel: "signpost", status: "needs_user", recipient: "https://x.test" },
    { channel: "open311", status: "pending", recipient: null },
  ]);
  const out = await deliverReport(REPORT_ID, deps);
  assert(out.kind === "processed");
  assertEquals(out.deliveries, []);
  assertEquals(sender.sent.length, 0);
  assertEquals(repo.patches, []);
  assertEquals(repo.updates, []);
  assertEquals(out.needsUser.length, 1);
});

Deno.test("idempotency: a delivery claimed by a concurrent run is not sent twice", async () => {
  const { repo, sender, deps } = setup();
  repo.claimFails.add(repo.deliveries[0].id);
  const out = await deliverReport(REPORT_ID, deps);
  assert(out.kind === "processed");
  assertEquals(sender.sent.length, 0);
  assertEquals(out.deliveries[0].action, "skipped");
  assertEquals(repo.updates, []);
});

Deno.test("photo privacy: flagged photos are not linked unless a moderator made them public", async () => {
  const { repo, sender, deps } = setup();
  const photo = (id: string, over: Partial<PhotoRow>) => ({
    report_id: REPORT_ID,
    id,
    storage_path: `${REPORT_ID}/${id}.jpg`,
    is_public: false,
    contains_people: false,
    contains_plates: false,
    sort_order: 0,
    ...over,
  });
  repo.photos = [
    photo("clean", { is_public: true }),
    photo("unknown", { contains_people: null, contains_plates: null }),
    photo("people", { contains_people: true }),
    photo("plates", { contains_plates: true }),
    photo("approved", { contains_plates: true, is_public: true }),
  ];
  await deliverReport(REPORT_ID, deps);
  assertEquals(repo.signed.map((s) => s.path.split("/")[1]), [
    "clean.jpg",
    "unknown.jpg",
    "approved.jpg",
  ]);
  assert(repo.signed.every((s) => s.ttl === PHOTO_LINK_TTL_SECONDS && s.ttl === 2_592_000));
  const msg = sender.sent[0];
  assertStringIncludes(msg.text, "Photo 1: https://storage.test/sign/report-photos/");
  assertStringIncludes(msg.text, "Photo 3:");
  assertFalse(msg.text.includes("people.jpg"));
  assertFalse(msg.text.includes("plates.jpg"));
  assertFalse(msg.html!.includes("people.jpg"));
  assertStringIncludes(msg.text, "2 further photos are being held back");
  assertStringIncludes(msg.text, "valid for 30 days");

  assert(isPhotoShareable(photo("x", {})));
  assertFalse(isPhotoShareable(photo("x", { contains_people: true })));
});

Deno.test("extra fields use category labels; HTML is escaped", async () => {
  const { sender, deps } = setup(
    baseReport({
      category_id: 7,
      extra: { registration: "AB12 CDE", colour: "Red", unknown_key: "x" },
      description: "<script>alert(1)</script> & more",
    }),
  );
  await deliverReport(REPORT_ID, deps);
  const msg = sender.sent[0];
  assertStringIncludes(msg.text, "Registration number: AB12 CDE");
  assertStringIncludes(msg.text, "Colour: Red");
  assertStringIncludes(msg.text, "unknown_key: x");
  assertFalse(msg.html!.includes("<script>"));
  assertStringIncludes(msg.html!, "&lt;script&gt;alert(1)&lt;/script&gt; &amp; more");
});

Deno.test("skips: unknown report, not-yet-routable status, hidden, awaiting moderation", async () => {
  const { deps, repo } = setup();
  assertEquals((await deliverReport("nope", deps)).kind, "not_found");

  repo.reports.get(REPORT_ID)!.status = "unrouted";
  let out = await deliverReport(REPORT_ID, deps);
  assertEquals(out.kind, "skipped");

  repo.reports.get(REPORT_ID)!.status = "submitted";
  repo.reports.get(REPORT_ID)!.needs_moderation = true;
  out = await deliverReport(REPORT_ID, deps);
  assert(out.kind === "processed");
  assertEquals(out.heldForModeration, true);
  assertEquals(out.sent, 0); // emails wait for a moderator
  out = await deliverReport(REPORT_ID, deps, { force: true });
  assert(out.kind === "processed");
  assertEquals(out.heldForModeration, false);

  repo.reports.get(REPORT_ID)!.is_hidden = true;
  out = await deliverReport(REPORT_ID, deps, { force: true });
  assertEquals(out.kind, "skipped");
});

Deno.test("handler: validation and status codes", async () => {
  const { deps } = setup();
  const h = createHandler(() => deps);
  const post = (body: unknown) =>
    h(new Request("http://x/deliver-report", { method: "POST", body: JSON.stringify(body) }));

  const bad = await post({});
  assertEquals(bad.status, 400);
  await bad.body?.cancel();
  const nf = await post({ report_id: "missing" });
  assertEquals(nf.status, 404);
  await nf.body?.cancel();
  const get = await h(new Request("http://x", { method: "GET" }));
  assertEquals(get.status, 405);
  await get.body?.cancel();

  const ok = await post({ report_id: REPORT_ID });
  assertEquals(ok.status, 200);
  const body = await ok.json();
  assertEquals(body.status, "processed");
  assertEquals(body.report_status, "sent");
  assertEquals(body.sent, 1);
  assertEquals(body.needs_user, []);
});

Deno.test("route-report trigger: deliverViaFunction posts to deliver-report or skips without config", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fakeFetch = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(
      new Response(JSON.stringify({ status: "processed", sent: 1 }), { status: 200 }),
    );
  }) as unknown as typeof fetch;
  const env = (vals: Record<string, string>) => (n: string) => vals[n];

  const res = await deliverViaFunction(
    "r1",
    env({ SUPABASE_URL: "http://kong:8000/", SUPABASE_SERVICE_ROLE_KEY: "svc" }),
    fakeFetch,
  );
  assertEquals(res, { status: "processed", sent: 1 });
  assertEquals(calls[0].url, "http://kong:8000/functions/v1/deliver-report");
  assertEquals((calls[0].init.headers as Record<string, string>).authorization, "Bearer svc");
  assertEquals(JSON.parse(String(calls[0].init.body)), { report_id: "r1" });

  const off = await deliverViaFunction(
    "r1",
    env({
      SUPABASE_URL: "http://kong:8000",
      SUPABASE_SERVICE_ROLE_KEY: "svc",
      AUTO_DELIVER: "false",
    }),
    fakeFetch,
  );
  assertEquals((off as { status: string }).status, "not_triggered");
  const none = await deliverViaFunction("r1", env({}), fakeFetch);
  assertEquals((none as { status: string }).status, "not_triggered");
  assertEquals(calls.length, 1);
});
