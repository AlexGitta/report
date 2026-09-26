import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  ANTHROPIC_URL,
  type ClassifyDeps,
  classifyPhoto,
  DEFAULT_MODEL,
  FALLBACK_MODEL,
  normaliseClassification,
  TOOL_NAME,
} from "./classify.ts";

interface Recorded {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

type Reply = Response | Error | ((body: Record<string, unknown>) => Response);

/** Mock fetch that returns queued replies in order and records requests. */
function mockFetch(replies: Reply[]) {
  const calls: Recorded[] = [];
  const fn = ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body,
    });
    const next = replies.shift();
    if (!next) return Promise.reject(new Error("unexpected fetch call"));
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(typeof next === "function" ? next(body) : next);
  }) as typeof fetch;
  return { fn, calls };
}

function toolResponse(input: unknown, usage = { input_tokens: 1500, output_tokens: 150 }): Response {
  return new Response(
    JSON.stringify({
      id: "msg_1",
      type: "message",
      role: "assistant",
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "toolu_1", name: TOOL_NAME, input }],
      usage,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function errorResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ type: "error", error: { type: "x", message: `status ${status}` } }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const goodInput = {
  candidates: [
    { category: "pothole", confidence: 0.91 },
    { category: "damaged_pavement", confidence: 0.06 },
    { category: "road_markings_signs", confidence: 0.02 },
  ],
  description: "Large pothole in the nearside lane with standing water.",
  severity: "high",
  contains_people: false,
  contains_plates: false,
  unsafe_or_irrelevant: false,
  reason: "Clear crater in tarmac road surface.",
};

const image = { imageBase64: "/9j/4AAQSkZJRgABAQ==", mediaType: "image/jpeg" };

// Escalation is opt-in (Sonnet is the default with no fallback); these tests configure it.
const HAIKU = "claude-haiku-4-5-20251001";
const SONNET = "claude-sonnet-5";
const ESCALATE = { model: HAIKU, fallbackModel: SONNET };

function deps(fetchFn: typeof fetch, extra: Partial<ClassifyDeps> = {}): ClassifyDeps {
  const sleeps: number[] = [];
  return {
    apiKey: "test-key",
    fetch: fetchFn,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    ...extra,
  };
}

Deno.test("happy path: haiku result returned, request shaped correctly", async () => {
  const m = mockFetch([toolResponse(goodInput)]);
  const res = await classifyPhoto({ ...image, contextHint: "on a busy road" }, deps(m.fn));

  assert(res.ok);
  assertEquals(res.model, DEFAULT_MODEL);
  assertEquals(res.fallback_used, false);
  assertEquals(res.result.candidates[0], { category: "pothole", confidence: 0.91 });
  assertEquals(res.result.severity, "high");
  assertEquals(res.usage, { input_tokens: 1500, output_tokens: 150 });

  assertEquals(m.calls.length, 1);
  const call = m.calls[0];
  assertEquals(call.url, ANTHROPIC_URL);
  assertEquals(call.headers["x-api-key"], "test-key");
  assertEquals(call.headers["anthropic-version"], "2023-06-01");
  assertEquals(call.body.model, DEFAULT_MODEL);
  assertEquals(call.body.tool_choice, { type: "tool", name: TOOL_NAME });
  const content = (call.body.messages as Array<{ content: Array<Record<string, unknown>> }>)[0].content;
  assertEquals(content[0].type, "image");
  assertEquals((content[0].source as Record<string, unknown>).media_type, "image/jpeg");
  assert(String(content[1].text).includes("on a busy road"));
});

Deno.test("low confidence on haiku -> falls back to sonnet once", async () => {
  const low = { ...goodInput, candidates: [{ category: "fly_tipping", confidence: 0.4 }] };
  const high = { ...goodInput, candidates: [{ category: "overflowing_litter_bin", confidence: 0.85 }] };
  const m = mockFetch([toolResponse(low), toolResponse(high, { input_tokens: 1600, output_tokens: 200 })]);
  const res = await classifyPhoto(image, deps(m.fn, ESCALATE));

  assert(res.ok);
  assertEquals(m.calls.length, 2);
  assertEquals(m.calls[0].body.model, HAIKU);
  assertEquals(m.calls[1].body.model, SONNET);
  assertEquals(res.model, SONNET);
  assertEquals(res.fallback_used, true);
  assertEquals(res.result.candidates[0].category, "overflowing_litter_bin");
  assertEquals(res.usage, { input_tokens: 3100, output_tokens: 350 });
});

Deno.test("low confidence and sonnet fails -> keeps haiku answer", async () => {
  const low = { ...goodInput, candidates: [{ category: "graffiti", confidence: 0.5 }] };
  const m = mockFetch([toolResponse(low), errorResponse(400)]);
  const res = await classifyPhoto(image, deps(m.fn, ESCALATE));
  assert(res.ok);
  assertEquals(res.model, HAIKU);
  assertEquals(res.result.candidates[0].category, "graffiti");
});

Deno.test("malformed tool output: escalates, then returns invalid_output", async () => {
  const noTool = new Response(
    JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: "It's a pothole" }], usage: {} }),
    { status: 200 },
  );
  const m = mockFetch([noTool, toolResponse({ candidates: "pothole" })]);
  const res = await classifyPhoto(image, deps(m.fn, ESCALATE));
  assert(!res.ok);
  assertEquals(res.error.code, "invalid_output");
  assertEquals(m.calls.length, 2);
});

Deno.test("malformed fields are repaired: clamp, sort, dedupe, truncate, conservative defaults", () => {
  const out = normaliseClassification({
    candidates: [
      { category: "graffiti", confidence: 0.3 },
      { category: "fly_tipping", confidence: 1.7 },
      { category: "graffiti", confidence: "0.5" },
      { category: "pothole", confidence: -2 },
      { category: "dog_fouling", confidence: 0.2 },
      { category: "noise" }, // no confidence -> dropped
    ],
    description: "x".repeat(400),
    severity: "catastrophic",
  });
  assert(out);
  assertEquals(out.candidates, [
    { category: "fly_tipping", confidence: 1 },
    { category: "graffiti", confidence: 0.5 },
    { category: "dog_fouling", confidence: 0.2 },
  ]);
  assertEquals(out.description.length, 280);
  assertEquals(out.severity, "medium");
  assertEquals(out.contains_people, true);
  assertEquals(out.contains_plates, true);
  assertEquals(out.unsafe_or_irrelevant, false);
  assertEquals(normaliseClassification(null), null);
  assertEquals(normaliseClassification({ description: "no candidates" }), null);
});

Deno.test("unknown categories are dropped", async () => {
  const input = {
    ...goodInput,
    candidates: [
      { category: "alien_invasion", confidence: 0.99 },
      { category: "graffiti", confidence: 0.8 },
      { category: "potholes", confidence: 0.7 },
    ],
  };
  const m = mockFetch([toolResponse(input)]);
  const res = await classifyPhoto(image, deps(m.fn, ESCALATE));
  assert(res.ok);
  assertEquals(res.result.candidates, [{ category: "graffiti", confidence: 0.8 }]);
  assertEquals(m.calls.length, 1);
});

Deno.test("only unknown categories -> 'other' at 0 confidence, triggers fallback", async () => {
  const input = { ...goodInput, candidates: [{ category: "banana", confidence: 0.99 }] };
  const m = mockFetch([toolResponse(input), toolResponse(input)]);
  const res = await classifyPhoto(image, deps(m.fn, ESCALATE));
  assert(res.ok);
  assertEquals(res.result.candidates, [{ category: "other", confidence: 0 }]);
  assertEquals(m.calls.length, 2);
});

Deno.test("429 then 529 are retried with backoff, then succeed", async () => {
  const sleeps: number[] = [];
  const m = mockFetch([errorResponse(429, { "retry-after": "2" }), errorResponse(529), toolResponse(goodInput)]);
  const res = await classifyPhoto(image, {
    apiKey: "k",
    fetch: m.fn,
    maxRetries: 2,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });
  assert(res.ok);
  assertEquals(m.calls.length, 3);
  assertEquals(sleeps.length, 2);
  assertEquals(sleeps[0], 2000); // honours retry-after
});

Deno.test("429 persists past max retries -> rate_limited error, no sonnet escalation", async () => {
  const m = mockFetch([errorResponse(429), errorResponse(429), errorResponse(429)]);
  const res = await classifyPhoto(image, deps(m.fn, { maxRetries: 2 }));
  assert(!res.ok);
  assertEquals(res.error.code, "rate_limited");
  assertEquals(res.error.status, 429);
  assertEquals(m.calls.length, 3);
});

Deno.test("default: exactly one API call, even on 529", async () => {
  const m = mockFetch([errorResponse(529), toolResponse(goodInput)]);
  const res = await classifyPhoto(image, deps(m.fn));
  assert(!res.ok);
  assertEquals(m.calls.length, 1);
});

Deno.test("non-retryable 400 is not retried", async () => {
  const m = mockFetch([errorResponse(400)]);
  const res = await classifyPhoto(image, deps(m.fn));
  assert(!res.ok);
  assertEquals(res.error.code, "api_error");
  assertEquals(m.calls.length, 1);
});

Deno.test("timeout -> timeout error", async () => {
  const hanging = ((_i: unknown, init?: RequestInit) =>
    new Promise<Response>((_r, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })) as typeof fetch;
  const res = await classifyPhoto(image, deps(hanging, { timeoutMs: 10 }));
  assert(!res.ok);
  assertEquals(res.error.code, "timeout");
});

Deno.test("refusal stop_reason -> refused error", async () => {
  const m = mockFetch([
    new Response(JSON.stringify({ stop_reason: "refusal", content: [], usage: {} }), { status: 200 }),
  ]);
  const res = await classifyPhoto(image, deps(m.fn, { fallbackModel: null }));
  assert(!res.ok);
  assertEquals(res.error.code, "refused");
});

Deno.test("missing api key / bad media type fail fast without fetch", async () => {
  const m = mockFetch([]);
  const a = await classifyPhoto(image, deps(m.fn, { apiKey: "" }));
  assert(!a.ok);
  assertEquals(a.error.code, "config");
  const b = await classifyPhoto({ ...image, mediaType: "image/gif" }, deps(m.fn));
  assert(!b.ok);
  assertEquals(b.error.code, "invalid_input");
  assertEquals(m.calls.length, 0);
});
