/**
 * HTTP handler for the classify-photo Edge Function. Kept separate from
 * index.ts (which only calls Deno.serve) so it can be unit-tested with
 * injected dependencies.
 */

import {
  ALLOWED_MEDIA_TYPES,
  type AllowedMediaType,
  type ClassifyErrorCode,
  type ClassifyInput,
  type ClassifyResult,
} from "../_shared/ai/classify.ts";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** base64 inflates by 4/3; allow some JSON overhead. */
const MAX_BODY_BYTES = Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 16 * 1024;
export const PHOTO_BUCKET = "report-photos";

export interface HandlerDeps {
  classify: (input: ClassifyInput) => Promise<ClassifyResult>;
  /** Download an object from the report-photos bucket. */
  download: (path: string) => Promise<Uint8Array>;
  allowedOrigins?: string[];
}

function corsHeaders(req: Request, allowed: string[] | undefined): Record<string, string> {
  const origin = req.headers.get("origin");
  let allowOrigin = "*";
  if (allowed && allowed.length > 0 && !allowed.includes("*")) {
    allowOrigin = origin && allowed.includes(origin) ? origin : allowed[0];
  }
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function json(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "content-type": "application/json; charset=utf-8" },
  });
}

function errorBody(code: string, message: string) {
  return { ok: false, error: { code, message } };
}

/** Detect image type from magic bytes. */
export function sniffMediaType(bytes: Uint8Array): AllowedMediaType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return "image/png";
  if (
    bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return "image/webp";
  return null;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64DecodedLength(b64: string): number {
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor(b64.length * 3 / 4) - padding;
}

function decodeBase64Prefix(b64: string): Uint8Array | null {
  try {
    const bin = atob(b64.slice(0, 24)); // 24 chars -> 18 bytes, enough for magic numbers
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

const ERROR_STATUS: Record<ClassifyErrorCode, number> = {
  config: 500,
  invalid_input: 400,
  rate_limited: 503,
  overloaded: 503,
  timeout: 504,
  network: 502,
  api_error: 502,
  invalid_output: 502,
  refused: 422,
};

export function createHandler(deps: HandlerDeps): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const cors = corsHeaders(req, deps.allowedOrigins);

    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    if (req.method !== "POST") return json(errorBody("method_not_allowed", "Use POST"), 405, cors);

    // The Supabase gateway verifies the JWT (verify_jwt defaults to true), so
    // here we only require that one was sent. Anonymous sign-ins count.
    const auth = req.headers.get("authorization") ?? "";
    if (!/^Bearer\s+\S+/i.test(auth)) {
      return json(errorBody("unauthorized", "Missing Authorization bearer token"), 401, cors);
    }
    // TODO: per-user rate limit (e.g. N classifications / hour keyed on the
    // JWT `sub`, stored in Postgres or a KV) — see PLAN.md §7 "Cost".

    const contentLength = Number(req.headers.get("content-length") ?? "0");
    if (contentLength > MAX_BODY_BYTES) {
      return json(errorBody("payload_too_large", "Image must be 5 MB or smaller"), 413, cors);
    }

    let body: Record<string, unknown>;
    try {
      const text = await req.text();
      if (text.length > MAX_BODY_BYTES) {
        return json(errorBody("payload_too_large", "Image must be 5 MB or smaller"), 413, cors);
      }
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      body = parsed;
    } catch {
      return json(errorBody("invalid_input", "Body must be a JSON object"), 400, cors);
    }

    const contextHint = typeof body.context_hint === "string" ? body.context_hint : undefined;
    let imageBase64: string;
    let mediaType: AllowedMediaType;

    if (typeof body.image_base64 === "string") {
      // Accept data URLs too ("data:image/jpeg;base64,....").
      imageBase64 = body.image_base64.replace(/^data:[^;]+;base64,/, "").replace(/\s+/g, "");
      if (!imageBase64 || !B64_RE.test(imageBase64)) {
        return json(errorBody("invalid_input", "image_base64 is not valid base64"), 400, cors);
      }
      if (base64DecodedLength(imageBase64) > MAX_IMAGE_BYTES) {
        return json(errorBody("payload_too_large", "Image must be 5 MB or smaller"), 413, cors);
      }
      const declared = body.media_type;
      if (typeof declared !== "string" || !ALLOWED_MEDIA_TYPES.includes(declared as AllowedMediaType)) {
        return json(
          errorBody("unsupported_media_type", `media_type must be one of ${ALLOWED_MEDIA_TYPES.join(", ")}`),
          415,
          cors,
        );
      }
      const prefix = decodeBase64Prefix(imageBase64);
      const sniffed = prefix ? sniffMediaType(prefix) : null;
      if (!sniffed) {
        return json(errorBody("unsupported_media_type", "Image is not a JPEG, PNG or WebP"), 415, cors);
      }
      // Trust the bytes over the declared type (the API rejects mismatches).
      mediaType = sniffed;
    } else if (typeof body.storage_path === "string") {
      const path = body.storage_path.trim();
      if (!path || path.startsWith("/") || path.includes("..") || path.length > 512) {
        return json(errorBody("invalid_input", "Invalid storage_path"), 400, cors);
      }
      // TODO: once the storage layout is fixed, check the path belongs to the
      // caller (e.g. starts with their user id) before downloading with the
      // service role.
      let bytes: Uint8Array;
      try {
        bytes = await deps.download(path);
      } catch (e) {
        console.error("storage download failed", path, e);
        return json(errorBody("not_found", "Could not download photo from storage"), 404, cors);
      }
      if (bytes.length > MAX_IMAGE_BYTES) {
        return json(errorBody("payload_too_large", "Image must be 5 MB or smaller"), 413, cors);
      }
      const sniffed = sniffMediaType(bytes);
      if (!sniffed) {
        return json(errorBody("unsupported_media_type", "Image is not a JPEG, PNG or WebP"), 415, cors);
      }
      mediaType = sniffed;
      imageBase64 = bytesToBase64(bytes);
    } else {
      return json(errorBody("invalid_input", "Provide image_base64 + media_type, or storage_path"), 400, cors);
    }

    const started = Date.now();
    const result = await deps.classify({ imageBase64, mediaType, contextHint });
    console.log(
      `classify-photo: ${result.ok ? result.model : "error"} in ${Date.now() - started}ms, ` +
        `${Math.round((imageBase64.length * 3) / 4 / 1024)}KB image`,
    );
    if (result.ok) {
      return json(
        {
          ok: true,
          result: result.result,
          model: result.model,
          usage: result.usage,
          fallback_used: result.fallback_used,
        },
        200,
        cors,
      );
    }
    console.error("classification failed", result.error);
    const status = ERROR_STATUS[result.error.code] ?? 500;
    // Don't leak upstream error details to clients.
    const message = status >= 500
      ? "Classification unavailable, please choose a category manually"
      : result.error.message;
    return json(errorBody(result.error.code, message), status, cors);
  };
}
