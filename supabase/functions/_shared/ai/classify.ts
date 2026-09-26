/**
 * Photo classification via the Anthropic Messages API (plain fetch, no SDK).
 *
 * Flow: primary model (Haiku) -> if the top candidate's confidence is below
 * the threshold, or the output is malformed, retry once with the fallback
 * model (Sonnet). 429/529/5xx are retried with backoff (max 2 retries per model).
 */

import { CATEGORY_SLUGS, type CategorySlug, isCategorySlug, renderCategoryGuide } from "./categories.ts";

export const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2023-06-01";
export const DEFAULT_MODEL = "claude-sonnet-5";
/** No escalation by default: Sonnet is the primary. Set CLASSIFY_FALLBACK_MODEL to re-enable. */
export const FALLBACK_MODEL: string | null = null;
export const FALLBACK_THRESHOLD = 0.6;
export const TOOL_NAME = "report_classification";
export const MAX_DESCRIPTION_CHARS = 280;
export const MAX_CANDIDATES = 3;

export type AllowedMediaType = "image/jpeg" | "image/png" | "image/webp";
export const ALLOWED_MEDIA_TYPES: readonly AllowedMediaType[] = ["image/jpeg", "image/png", "image/webp"];

export type Severity = "low" | "medium" | "high";

export interface Candidate {
  category: CategorySlug;
  confidence: number;
}

export interface Classification {
  candidates: Candidate[];
  description: string;
  severity: Severity;
  contains_people: boolean;
  contains_plates: boolean;
  unsafe_or_irrelevant: boolean;
  reason: string;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

export type ClassifyErrorCode =
  | "config"
  | "invalid_input"
  | "rate_limited"
  | "overloaded"
  | "timeout"
  | "network"
  | "api_error"
  | "invalid_output"
  | "refused";

export interface ClassifyError {
  code: ClassifyErrorCode;
  message: string;
  status?: number;
}

export type ClassifyResult =
  | { ok: true; result: Classification; model: string; usage: Usage; fallback_used: boolean }
  | { ok: false; error: ClassifyError; usage: Usage };

export interface ClassifyInput {
  imageBase64: string;
  mediaType: string;
  /** Free-text context, e.g. "on a road" / "in a park" / user's note. */
  contextHint?: string;
}

export interface ClassifyDeps {
  apiKey: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  model?: string;
  fallbackModel?: string | null;
  fallbackThreshold?: number;
  /** Per-request timeout in ms. */
  timeoutMs?: number;
  /** Retries for 429/529/5xx per model call. */
  maxRetries?: number;
  baseDelayMs?: number;
  url?: string;
}

export const SYSTEM_PROMPT =
  `You triage photos submitted to a citizen problem-reporting app in England. Reports are routed to the local council (or highways authority) responsible for fixing street-level problems.

Look at the photo (and the optional context from the reporter) and call ${TOOL_NAME} exactly once.

Categories:
${renderCategoryGuide()}

Rules:
- candidates: up to 3 plausible categories, most likely first, confidence 0-1. Be calibrated: use high confidence only when the problem is clearly visible. Use "other" only if a real public-realm problem fits no category.
- description: one neutral, factual sentence or two in UK English (max 280 characters) describing the problem and where it is in the frame, suitable for a council officer. Describe the problem, not people.
- Never identify, name or describe individuals (no faces, clothing, ethnicity, age guesses) and never transcribe number plates, house numbers of private homes or other personal details.
- contains_people: true if any person or recognisable face is visible, even in the background. contains_plates: true if any vehicle number plate is visible, even partly.
- severity: high = immediate danger (deep pothole on a busy road, exposed wiring, needles in a play area, blocked carriageway); medium = needs fixing soon; low = cosmetic or minor.
- unsafe_or_irrelevant: true for selfies, memes, screenshots, photos with no public-realm problem, and any explicit, violent or otherwise inappropriate content. When true, keep the description brief and generic.
- reason: short justification for your top candidate (max ~200 characters).`;

export const TOOL_DEFINITION = {
  name: TOOL_NAME,
  description: "Report the classification of the submitted problem photo.",
  input_schema: {
    type: "object",
    properties: {
      candidates: {
        type: "array",
        description: "Top 3 most likely categories, most likely first.",
        maxItems: MAX_CANDIDATES,
        minItems: 1,
        items: {
          type: "object",
          properties: {
            category: { type: "string", enum: [...CATEGORY_SLUGS] },
            confidence: { type: "number", minimum: 0, maximum: 1 },
          },
          required: ["category", "confidence"],
          additionalProperties: false,
        },
      },
      description: {
        type: "string",
        description: "Neutral UK-English description, max 280 characters, no personal identification.",
        maxLength: MAX_DESCRIPTION_CHARS,
      },
      severity: { type: "string", enum: ["low", "medium", "high"] },
      contains_people: { type: "boolean" },
      contains_plates: { type: "boolean" },
      unsafe_or_irrelevant: { type: "boolean" },
      reason: { type: "string" },
    },
    required: [
      "candidates",
      "description",
      "severity",
      "contains_people",
      "contains_plates",
      "unsafe_or_irrelevant",
      "reason",
    ],
    additionalProperties: false,
  },
} as const;

const ZERO_USAGE: Usage = { input_tokens: 0, output_tokens: 0 };

function addUsage(a: Usage, b: Usage): Usage {
  return { input_tokens: a.input_tokens + b.input_tokens, output_tokens: a.output_tokens + b.output_tokens };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function toNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + "…";
}

function cleanText(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  return truncate(v.replace(/\s+/g, " ").trim(), max);
}

/**
 * Validates and normalises raw tool input. Returns null if the output is
 * unusable (not an object / no candidates array). Individual bad fields are
 * repaired: unknown categories dropped, confidences clamped, duplicates
 * merged, sorted desc, top 3 kept. Privacy flags default to TRUE when
 * missing (conservative: the photo stays private until moderated).
 */
export function normaliseClassification(raw: unknown): Classification | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.candidates)) return null;

  const best = new Map<CategorySlug, number>();
  for (const c of r.candidates) {
    if (!c || typeof c !== "object") continue;
    const { category, confidence } = c as Record<string, unknown>;
    const cat = typeof category === "string" ? category.trim().toLowerCase() : category;
    if (!isCategorySlug(cat)) continue;
    const conf = toNumber(confidence);
    if (conf === null) continue;
    const clamped = clamp01(conf);
    best.set(cat, Math.max(best.get(cat) ?? 0, clamped));
  }

  let candidates: Candidate[] = [...best.entries()]
    .map(([category, confidence]) => ({ category, confidence: Math.round(confidence * 1000) / 1000 }))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, MAX_CANDIDATES);
  if (candidates.length === 0) candidates = [{ category: "other", confidence: 0 }];

  const severity: Severity = r.severity === "low" || r.severity === "medium" || r.severity === "high"
    ? r.severity
    : "medium";

  return {
    candidates,
    description: cleanText(r.description, MAX_DESCRIPTION_CHARS),
    severity,
    contains_people: typeof r.contains_people === "boolean" ? r.contains_people : true,
    contains_plates: typeof r.contains_plates === "boolean" ? r.contains_plates : true,
    unsafe_or_irrelevant: typeof r.unsafe_or_irrelevant === "boolean" ? r.unsafe_or_irrelevant : false,
    reason: cleanText(r.reason, 500),
  };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

type CallOutcome =
  | { ok: true; classification: Classification; usage: Usage }
  | { ok: false; error: ClassifyError; usage: Usage };

function buildBody(model: string, input: ClassifyInput) {
  const hint = input.contextHint?.trim().slice(0, 500);
  return {
    model,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    tools: [TOOL_DEFINITION],
    tool_choice: { type: "tool", name: TOOL_NAME },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: input.mediaType, data: input.imageBase64 },
          },
          {
            type: "text",
            text: hint
              ? `Reporter's context (untrusted, may be wrong): ${hint}\nClassify this photo.`
              : "Classify this photo.",
          },
        ],
      },
    ],
  };
}

function parseRetryAfter(h: string | null): number | null {
  if (!h) return null;
  const secs = Number(h);
  return Number.isFinite(secs) && secs >= 0 ? secs * 1000 : null;
}

function readUsage(json: unknown): Usage {
  const u = (json as { usage?: Record<string, unknown> } | null)?.usage;
  return {
    input_tokens: toNumber(u?.input_tokens) ?? 0,
    output_tokens: toNumber(u?.output_tokens) ?? 0,
  };
}

const RETRYABLE = new Set([429, 500, 502, 503, 504, 529]);

async function callModel(model: string, input: ClassifyInput, deps: ClassifyDeps): Promise<CallOutcome> {
  const doFetch = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  // One call per photo by default: retries double the wait on a slow link. Opt in via deps.
  const maxRetries = deps.maxRetries ?? 0;
  const baseDelay = deps.baseDelayMs ?? 500;
  const timeoutMs = deps.timeoutMs ?? 30_000;
  const body = JSON.stringify(buildBody(model, input));

  let lastError: ClassifyError = { code: "api_error", message: "No attempt made" };
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await doFetch(deps.url ?? ANTHROPIC_URL, {
        method: "POST",
        headers: {
          "x-api-key": deps.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
          "content-type": "application/json",
        },
        body,
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      if (controller.signal.aborted) {
        return {
          ok: false,
          error: { code: "timeout", message: `Request timed out after ${timeoutMs}ms` },
          usage: ZERO_USAGE,
        };
      }
      lastError = { code: "network", message: e instanceof Error ? e.message : String(e) };
      if (attempt < maxRetries) {
        await sleep(baseDelay * 2 ** attempt);
        continue;
      }
      return { ok: false, error: lastError, usage: ZERO_USAGE };
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      json = null;
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const apiMsg = (json as { error?: { message?: string } } | null)?.error?.message ?? res.statusText;
      const code: ClassifyErrorCode = res.status === 429
        ? "rate_limited"
        : res.status === 529
        ? "overloaded"
        : "api_error";
      lastError = { code, message: `Anthropic API ${res.status}: ${apiMsg}`, status: res.status };
      if (RETRYABLE.has(res.status) && attempt < maxRetries) {
        const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
        const backoff = baseDelay * 2 ** attempt + Math.floor(Math.random() * 100);
        await sleep(Math.min(retryAfter ?? backoff, 10_000));
        continue;
      }
      return { ok: false, error: lastError, usage: ZERO_USAGE };
    }

    const usage = readUsage(json);
    const msg = json as { stop_reason?: string; content?: Array<Record<string, unknown>> } | null;
    if (msg?.stop_reason === "refusal") {
      return { ok: false, error: { code: "refused", message: "Model declined to classify this image" }, usage };
    }
    const toolUse = msg?.content?.find((b) => b?.type === "tool_use" && b?.name === TOOL_NAME);
    const classification = normaliseClassification(toolUse?.input);
    if (!classification) {
      return {
        ok: false,
        error: { code: "invalid_output", message: `Model ${model} returned no valid ${TOOL_NAME} output` },
        usage,
      };
    }
    return { ok: true, classification, usage };
  }
  return { ok: false, error: lastError, usage: ZERO_USAGE };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function classifyPhoto(input: ClassifyInput, deps: ClassifyDeps): Promise<ClassifyResult> {
  if (!deps.apiKey) {
    return { ok: false, error: { code: "config", message: "ANTHROPIC_API_KEY is not set" }, usage: ZERO_USAGE };
  }
  if (!ALLOWED_MEDIA_TYPES.includes(input.mediaType as AllowedMediaType)) {
    return {
      ok: false,
      error: { code: "invalid_input", message: `Unsupported media type: ${input.mediaType}` },
      usage: ZERO_USAGE,
    };
  }
  if (!input.imageBase64) {
    return { ok: false, error: { code: "invalid_input", message: "Empty image" }, usage: ZERO_USAGE };
  }

  const primaryModel = deps.model ?? DEFAULT_MODEL;
  const fallbackModel = deps.fallbackModel === undefined ? FALLBACK_MODEL : deps.fallbackModel;
  const threshold = deps.fallbackThreshold ?? FALLBACK_THRESHOLD;

  const first = await callModel(primaryModel, input, deps);
  let usage = first.usage;

  const topConfidence = first.ok ? first.classification.candidates[0].confidence : 0;
  // Escalate on low confidence or unusable output. Transport errors
  // (rate limit, timeout, config) are not escalated — Sonnet would hit them too.
  const shouldEscalate = fallbackModel && fallbackModel !== primaryModel &&
    (first.ok ? topConfidence < threshold : first.error.code === "invalid_output");

  if (shouldEscalate) {
    const second = await callModel(fallbackModel, input, deps);
    usage = addUsage(usage, second.usage);
    if (second.ok) {
      return { ok: true, result: second.classification, model: fallbackModel, usage, fallback_used: true };
    }
    // Fallback failed: keep the low-confidence primary answer if we have one.
    if (first.ok) {
      return { ok: true, result: first.classification, model: primaryModel, usage, fallback_used: false };
    }
    return { ok: false, error: second.error, usage };
  }

  if (first.ok) {
    return { ok: true, result: first.classification, model: primaryModel, usage, fallback_used: false };
  }
  return { ok: false, error: first.error, usage };
}
