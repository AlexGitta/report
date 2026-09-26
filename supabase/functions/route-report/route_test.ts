import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { GeoLookupError, type CouncilLookupResult, type PoliceLookupResult } from "../_shared/routing/geo.ts";
import { POLICE_UK_URL, type RouteDeps, routeReport } from "./route.ts";
import { createHandler } from "./handler.ts";
import type {
  AuthorityRow,
  CategoryRow,
  ContactRow,
  PoliceForceRow,
  ReportRow,
  RoutingRepo,
  RoutingUpdate,
  UnroutedUpdate,
} from "./repo.ts";

class FakeRepo implements RoutingRepo {
  reports = new Map<string, ReportRow>();
  categories = new Map<string, CategoryRow>();
  authorities = new Map<string, AuthorityRow>();
  contacts: ContactRow[] = [];
  forces = new Map<string, PoliceForceRow>();
  saved: RoutingUpdate[] = [];
  unrouted: UnroutedUpdate[] = [];
  ensured: Omit<AuthorityRow, "website">[] = [];

  getReport(id: string) {
    return Promise.resolve(this.reports.get(id) ?? null);
  }
  getCategory(id: string | number) {
    return Promise.resolve(this.categories.get(String(id)) ?? null);
  }
  getAuthorities(gss: string[]) {
    return Promise.resolve(gss.flatMap((g) => this.authorities.get(g) ?? []));
  }
  ensureAuthorities(rows: Omit<AuthorityRow, "website">[]) {
    for (const r of rows) {
      this.ensured.push(r);
      if (!this.authorities.has(r.gss_code)) this.authorities.set(r.gss_code, r);
    }
    return Promise.resolve();
  }
  getContacts(gss: string[]) {
    return Promise.resolve(this.contacts.filter((c) => gss.includes(c.authority_gss)));
  }
  getPoliceForce(id: string) {
    return Promise.resolve(this.forces.get(id) ?? null);
  }
  saveRouting(u: RoutingUpdate) {
    this.saved.push(u);
    return Promise.resolve();
  }
  markUnrouted(u: UnroutedUpdate) {
    this.unrouted.push(u);
    const r = this.reports.get(u.reportId);
    if (r) r.status = "unrouted";
    return Promise.resolve();
  }
}

const CATS: CategoryRow[] = [
  { id: 1, slug: "pothole", category_group: "roads", routing_target: "highway" },
  { id: 2, slug: "missed_bin", category_group: "waste", routing_target: "waste_collection" },
  { id: 3, slug: "graffiti", category_group: "street_scene", routing_target: "district_or_unitary" },
  { id: 4, slug: "asb", category_group: "community_safety", routing_target: "asb" },
  { id: 5, slug: "fly_tipping", category_group: "waste", routing_target: "waste_collection" },
  { id: 9, slug: "weird", category_group: "roads", routing_target: "nonsense" },
];

const MAIDSTONE: CouncilLookupResult = {
  district: { gss: "E07000110", name: "Maidstone" },
  county: { gss: "E10000016", name: "Kent" },
  country: "England",
  postcode: "ME14 1SN",
  distanceM: 45,
  radiusM: 100,
};
const CAMDEN: CouncilLookupResult = {
  district: { gss: "E09000007", name: "Camden" },
  county: null,
  country: "England",
  postcode: "NW1 7PJ",
  distanceM: 31,
  radiusM: 100,
};
const CARDIFF: CouncilLookupResult = {
  district: { gss: "W06000015", name: "Cardiff" },
  county: null,
  country: "Wales",
  postcode: "CF10 2AF",
  distanceM: 19,
  radiusM: 100,
};
const KENT_POLICE: PoliceLookupResult = { force: "kent", neighbourhood: "YA11" };

function setup(opts: {
  categoryId: number;
  councils?: CouncilLookupResult | null | Error;
  police?: PoliceLookupResult | null | Error;
  status?: string;
  location?: unknown;
}) {
  const repo = new FakeRepo();
  for (const c of CATS) repo.categories.set(String(c.id), c);
  repo.reports.set("r1", {
    id: "r1",
    category_id: opts.categoryId,
    status: opts.status ?? "submitted",
    location: "location" in opts ? opts.location : "SRID=4326;POINT(0.5217 51.2724)",
  });
  repo.authorities.set("E10000016", {
    gss_code: "E10000016",
    name: "Kent County Council",
    type: "E10",
    parent_gss: null,
    website: "https://www.kent.gov.uk",
  });
  repo.authorities.set("E07000110", {
    gss_code: "E07000110",
    name: "Maidstone Borough Council",
    type: "E07",
    parent_gss: "E10000016",
    website: "https://maidstone.gov.uk",
  });
  repo.forces.set("kent", {
    id: "kent",
    name: "Kent Police",
    report_url: "https://www.kent.police.uk/ro/report/",
    non_emergency_url: null,
  });
  const calls: string[] = [];
  const deps: RouteDeps = {
    repo,
    lookupCouncils: (lat, lng) => {
      calls.push(`councils ${lat},${lng}`);
      const c = opts.councils === undefined ? MAIDSTONE : opts.councils;
      return c instanceof Error ? Promise.reject(c) : Promise.resolve(c);
    },
    lookupPolice: () => {
      const p = opts.police === undefined ? KENT_POLICE : opts.police;
      return p instanceof Error ? Promise.reject(p) : Promise.resolve(p);
    },
  };
  return { repo, deps, calls };
}

Deno.test("pothole in Maidstone -> Kent CC by email when a contact exists", async () => {
  const { repo, deps, calls } = setup({ categoryId: 1 });
  repo.contacts.push({
    authority_gss: "E10000016",
    category_group: "roads",
    category_id: null,
    email: "highways@kent.example",
    form_url: null,
  });
  const out = await routeReport("r1", deps);
  assertEquals(out.kind, "routed");
  assertEquals(calls, ["councils 51.2724,0.5217"]);
  assertEquals(repo.saved.length, 1);
  const s = repo.saved[0];
  assertEquals(s.routedAuthorities, ["E10000016"]);
  assertEquals(s.policeForceId, "kent");
  assertEquals(s.policeNeighbourhood, "YA11");
  assertEquals(s.deliveries, [{
    report_id: "r1",
    authority_gss: "E10000016",
    police_force_id: null,
    channel: "email",
    status: "pending",
    recipient: "highways@kent.example",
  }]);
  assertEquals(repo.unrouted, []);
});

Deno.test("missed bin in Maidstone -> Maidstone signpost to its own form", async () => {
  const { repo, deps } = setup({ categoryId: 2 });
  repo.contacts.push({
    authority_gss: "E07000110",
    category_group: "waste",
    category_id: null,
    email: "waste@maidstone.example",
    form_url: "https://maidstone.gov.uk/missed-bin",
  });
  await routeReport("r1", deps);
  const d = repo.saved[0].deliveries;
  assertEquals(d.length, 1);
  assertEquals(d[0].authority_gss, "E07000110");
  assertEquals(d[0].channel, "signpost");
  assertEquals(d[0].recipient, "https://maidstone.gov.uk/missed-bin");
});

Deno.test("no contact -> signpost to authority website", async () => {
  const { repo, deps } = setup({ categoryId: 5 });
  await routeReport("r1", deps);
  const d = repo.saved[0].deliveries[0];
  assertEquals(d.channel, "signpost");
  assertEquals(d.recipient, "https://maidstone.gov.uk");
});

Deno.test("contact precedence: category_id > category_group > catch-all (null group)", async () => {
  const { repo, deps } = setup({ categoryId: 3 });
  const c = (category_group: string | null, category_id: number | null, email: string) => ({
    authority_gss: "E07000110",
    category_group,
    category_id,
    email,
    form_url: null,
  });
  repo.contacts.push(c(null, null, "general@maidstone.example"));
  await routeReport("r1", deps);
  assertEquals(repo.saved[0].deliveries[0].recipient, "general@maidstone.example");

  repo.contacts.push(c("roads", null, "wrong@maidstone.example"));
  repo.contacts.push(c("street_scene", null, "streets@maidstone.example"));
  await routeReport("r1", deps, { force: true });
  assertEquals(repo.saved[1].deliveries[0].recipient, "streets@maidstone.example");

  repo.contacts.push(c(null, 3, "graffiti@maidstone.example"));
  await routeReport("r1", deps, { force: true });
  assertEquals(repo.saved[2].deliveries[0].recipient, "graffiti@maidstone.example");
});

Deno.test("contact precedence: higher priority wins among equally specific matches", async () => {
  const { repo, deps } = setup({ categoryId: 3 });
  const row = (form_url: string, priority?: number) => ({
    authority_gss: "E07000110",
    category_group: null,
    category_id: 3,
    email: null,
    form_url,
    priority,
  });
  // GOV.UK generic page first, verified deep link second: order in the table must not matter.
  repo.contacts.push(row("https://maidstone.example/info-page"));
  repo.contacts.push(row("https://maidstone.example/forms/graffiti", 100));
  await routeReport("r1", deps);
  assertEquals(repo.saved[0].deliveries[0].recipient, "https://maidstone.example/forms/graffiti");
});

Deno.test("ASB -> district ASB team plus police signpost delivery", async () => {
  const { repo, deps } = setup({ categoryId: 4 });
  const out = await routeReport("r1", deps);
  assert(out.kind === "routed");
  assert(out.warnings.some((w) => w.code === "police_signpost"));
  const d = repo.saved[0].deliveries;
  assertEquals(d.map((x) => [x.authority_gss, x.police_force_id, x.channel]), [
    ["E07000110", null, "signpost"],
    [null, "kent", "signpost"],
  ]);
  assertEquals(d[1].recipient, "https://www.kent.police.uk/ro/report/");
});

Deno.test("ASB with a force not in police_forces: no police row, no FK", async () => {
  const { repo, deps } = setup({ categoryId: 4, police: { force: "unknown", neighbourhood: "X" } });
  await routeReport("r1", deps);
  const s = repo.saved[0];
  assertEquals(s.policeForceId, null);
  assertEquals(s.policeNeighbourhood, "X");
  assertEquals(s.deliveries.length, 1);
  assertEquals(POLICE_UK_URL, "https://www.police.uk/");
});

Deno.test("London highway -> borough, red route warning, authority auto-created", async () => {
  const { repo, deps } = setup({
    categoryId: 1,
    councils: CAMDEN,
    police: { force: "metropolitan", neighbourhood: "E05013655N" },
  });
  const out = await routeReport("r1", deps);
  assert(out.kind === "routed");
  assertEquals(out.routedAuthorities, ["E09000007"]);
  assert(out.warnings.some((w) => w.code === "london_red_route"));
  assertEquals(repo.ensured, [{ gss_code: "E09000007", name: "Camden", type: "E09", parent_gss: null }]);
  // metropolitan force not seeded -> null FK
  assertEquals(repo.saved[0].policeForceId, null);
});

Deno.test("missing county from postcodes.io falls back to authorities.parent_gss", async () => {
  const { repo, deps } = setup({ categoryId: 1, councils: { ...MAIDSTONE, county: null } });
  await routeReport("r1", deps);
  assertEquals(repo.saved[0].routedAuthorities, ["E10000016"]);
});

Deno.test("missing county and no parent_gss -> unrouted + timeline row", async () => {
  const { repo, deps } = setup({ categoryId: 1, councils: { ...MAIDSTONE, county: null } });
  repo.authorities.delete("E07000110");
  const out = await routeReport("r1", deps);
  assertEquals(out.kind, "unrouted");
  assertEquals(repo.unrouted[0].reason, "missing_county");
  assertEquals(repo.unrouted[0].policeForceId, "kent");
  assertEquals(repo.saved, []);
});

Deno.test("outside England (Wales) -> unrouted", async () => {
  const { repo, deps } = setup({ categoryId: 1, councils: CARDIFF, police: null });
  const out = await routeReport("r1", deps);
  assert(out.kind === "unrouted");
  assertEquals(out.reason, "outside_england");
  assertEquals(repo.reports.get("r1")!.status, "unrouted");
});

Deno.test("no postcode within 2km -> unrouted no_council", async () => {
  const { repo, deps } = setup({ categoryId: 2, councils: null });
  const out = await routeReport("r1", deps);
  assert(out.kind === "unrouted");
  assertEquals(out.reason, "no_council");
  assertEquals(repo.unrouted.length, 1);
});

Deno.test("missing / bad location -> unrouted without lookups", async () => {
  const { repo, deps, calls } = setup({ categoryId: 1, location: null });
  const out = await routeReport("r1", deps);
  assert(out.kind === "unrouted");
  assertEquals(out.reason, "no_location");
  assertEquals(calls, []);
  assertEquals(repo.unrouted.length, 1);
});

Deno.test("bad routing_target -> unrouted", async () => {
  const { deps } = setup({ categoryId: 9 });
  const out = await routeReport("r1", deps);
  assert(out.kind === "unrouted");
  assertEquals(out.reason, "bad_routing_target");
});

Deno.test("postcodes.io outage propagates (retryable) and writes nothing", async () => {
  const { repo, deps } = setup({
    categoryId: 1,
    councils: new GeoLookupError("postcodes.io", "timeout", "slow"),
  });
  await assertRejects(() => routeReport("r1", deps), GeoLookupError);
  assertEquals(repo.saved, []);
  assertEquals(repo.unrouted, []);
});

Deno.test("police outage is tolerated for pothole but not for ASB", async () => {
  const err = () => new GeoLookupError("police.uk", "http", "down", { status: 503 });
  const a = setup({ categoryId: 1, police: err() });
  const out = await routeReport("r1", a.deps);
  assertEquals(out.kind, "routed");
  assertEquals(a.repo.saved[0].policeForceId, null);

  const b = setup({ categoryId: 4, police: err() });
  await assertRejects(() => routeReport("r1", b.deps), GeoLookupError);
});

Deno.test("report not found / skipped status / force", async () => {
  const { deps } = setup({ categoryId: 1, status: "sent" });
  assertEquals((await routeReport("nope", deps)).kind, "not_found");
  assertEquals((await routeReport("r1", deps)).kind, "skipped");
  assertEquals((await routeReport("r1", deps, { force: true })).kind, "routed");
});

Deno.test("handler: validation and status codes", async () => {
  const { deps } = setup({ categoryId: 1 });
  const h = createHandler(() => deps);
  const post = (body: unknown) =>
    h(new Request("http://x/route-report", { method: "POST", body: JSON.stringify(body) }));

  assertEquals((await h(new Request("http://x", { method: "GET" }))).status, 405);
  assertEquals((await post({})).status, 400);
  assertEquals((await post({ report_id: "missing" })).status, 404);
  const ok = await post({ report_id: "r1" });
  assertEquals(ok.status, 200);
  const body = await ok.json();
  assertEquals(body.status, "routed");
  assertEquals(body.routed_authorities, ["E10000016"]);

  const down = setup({
    categoryId: 1,
    councils: new GeoLookupError("postcodes.io", "http", "x", { status: 502 }),
  });
  const r503 = await createHandler(() => down.deps)(
    new Request("http://x", { method: "POST", body: JSON.stringify({ report_id: "r1" }) }),
  );
  assertEquals(r503.status, 503);
  await r503.body?.cancel();
});
