import { assert, assertEquals } from "jsr:@std/assert@1";
import { bytesToBase64, createHandler, type HandlerDeps, MAX_IMAGE_BYTES, sniffMediaType } from "./handler.ts";
import type { ClassifyInput, ClassifyResult } from "../_shared/ai/classify.ts";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);

const okResult: ClassifyResult = {
  ok: true,
  model: "claude-haiku-4-5-20251001",
  fallback_used: false,
  usage: { input_tokens: 1500, output_tokens: 150 },
  result: {
    candidates: [{ category: "pothole", confidence: 0.9 }],
    description: "Pothole in road.",
    severity: "medium",
    contains_people: false,
    contains_plates: false,
    unsafe_or_irrelevant: false,
    reason: "Visible crater.",
  },
};

function setup(overrides: Partial<HandlerDeps> = {}) {
  const seen: ClassifyInput[] = [];
  const handler = createHandler({
    classify: (input) => {
      seen.push(input);
      return Promise.resolve(okResult);
    },
    download: () => Promise.resolve(PNG),
    ...overrides,
  });
  return { handler, seen };
}

function post(body: unknown, headers: Record<string, string> = { authorization: "Bearer jwt" }) {
  return new Request("http://localhost/classify-photo", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

Deno.test("OPTIONS preflight returns CORS headers", async () => {
  const { handler } = setup();
  const res = await handler(new Request("http://localhost/", { method: "OPTIONS" }));
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("access-control-allow-origin"), "*");
  assert(res.headers.get("access-control-allow-headers")?.includes("authorization"));
  await res.body?.cancel();
});

Deno.test("missing Authorization -> 401", async () => {
  const { handler } = setup();
  const res = await handler(post({ image_base64: bytesToBase64(JPEG), media_type: "image/jpeg" }, {}));
  assertEquals(res.status, 401);
  assertEquals((await res.json()).error.code, "unauthorized");
});

Deno.test("image_base64 happy path returns classification", async () => {
  const { handler, seen } = setup();
  const res = await handler(
    post({ image_base64: bytesToBase64(JPEG), media_type: "image/jpeg", context_hint: "in a park" }),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.ok, true);
  assertEquals(body.result.candidates[0].category, "pothole");
  assertEquals(body.model, "claude-haiku-4-5-20251001");
  assertEquals(seen[0].mediaType, "image/jpeg");
  assertEquals(seen[0].contextHint, "in a park");
});

Deno.test("declared type mismatching bytes is corrected from magic bytes", async () => {
  const { handler, seen } = setup();
  const res = await handler(post({ image_base64: bytesToBase64(PNG), media_type: "image/jpeg" }));
  assertEquals(res.status, 200);
  await res.body?.cancel();
  assertEquals(seen[0].mediaType, "image/png");
});

Deno.test("disallowed media type -> 415", async () => {
  const { handler } = setup();
  const res = await handler(post({ image_base64: bytesToBase64(JPEG), media_type: "image/gif" }));
  assertEquals(res.status, 415);
  await res.body?.cancel();
});

Deno.test("non-image bytes -> 415", async () => {
  const { handler } = setup();
  const res = await handler(post({ image_base64: btoa("hello world, not an image"), media_type: "image/jpeg" }));
  assertEquals(res.status, 415);
  await res.body?.cancel();
});

Deno.test("oversize image -> 413", async () => {
  const { handler } = setup();
  const big = new Uint8Array(MAX_IMAGE_BYTES + 10);
  big.set(JPEG);
  const res = await handler(post({ image_base64: bytesToBase64(big), media_type: "image/jpeg" }));
  assertEquals(res.status, 413);
  await res.body?.cancel();
});

Deno.test("storage_path downloads from bucket and sniffs type", async () => {
  const paths: string[] = [];
  const { handler, seen } = setup({
    download: (p) => {
      paths.push(p);
      return Promise.resolve(PNG);
    },
  });
  const res = await handler(post({ storage_path: "user-1/report-9/photo.png" }));
  assertEquals(res.status, 200);
  await res.body?.cancel();
  assertEquals(paths, ["user-1/report-9/photo.png"]);
  assertEquals(seen[0].mediaType, "image/png");
  assertEquals(seen[0].imageBase64, bytesToBase64(PNG));
});

Deno.test("storage_path traversal rejected; download failure -> 404", async () => {
  const { handler } = setup({ download: () => Promise.reject(new Error("nope")) });
  const bad = await handler(post({ storage_path: "../secrets" }));
  assertEquals(bad.status, 400);
  await bad.body?.cancel();
  const missing = await handler(post({ storage_path: "a/b.jpg" }));
  assertEquals(missing.status, 404);
  await missing.body?.cancel();
});

Deno.test("classifier errors map to status codes without leaking details", async () => {
  const { handler } = setup({
    classify: () =>
      Promise.resolve({
        ok: false,
        error: { code: "rate_limited", message: "Anthropic API 429: secret detail", status: 429 },
        usage: { input_tokens: 0, output_tokens: 0 },
      }),
  });
  const res = await handler(post({ image_base64: bytesToBase64(JPEG), media_type: "image/jpeg" }));
  assertEquals(res.status, 503);
  const body = await res.json();
  assertEquals(body.error.code, "rate_limited");
  assert(!body.error.message.includes("secret"));
});

Deno.test("bad JSON / missing fields / wrong method", async () => {
  const { handler } = setup();
  const a = await handler(post("{not json"));
  assertEquals(a.status, 400);
  await a.body?.cancel();
  const b = await handler(post({ foo: 1 }));
  assertEquals(b.status, 400);
  await b.body?.cancel();
  const c = await handler(new Request("http://localhost/", { method: "GET" }));
  assertEquals(c.status, 405);
  await c.body?.cancel();
});

Deno.test("sniffMediaType recognises webp", () => {
  const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  assertEquals(sniffMediaType(webp), "image/webp");
  assertEquals(sniffMediaType(new Uint8Array([1, 2, 3])), null);
});
