// Supabase Edge Function: classify-photo
// POST { image_base64, media_type, context_hint? } | { storage_path, context_hint? }
// See README.md in this directory.

import { createClient } from "npm:@supabase/supabase-js@2";
import { classifyPhoto } from "../_shared/ai/classify.ts";
import { createHandler, PHOTO_BUCKET } from "./handler.ts";

const apiKey = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const allowedOrigins = (Deno.env.get("CLASSIFY_ALLOWED_ORIGINS") ?? "*")
  .split(",").map((s) => s.trim()).filter(Boolean);

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const handler = createHandler({
  allowedOrigins,
  classify: (input) =>
    classifyPhoto(input, {
      apiKey,
      model: Deno.env.get("CLASSIFY_MODEL") || undefined,
      fallbackModel: Deno.env.get("CLASSIFY_FALLBACK_MODEL") || undefined,
    }),
  download: async (path) => {
    const { data, error } = await supabase.storage.from(PHOTO_BUCKET).download(path);
    if (error || !data) throw error ?? new Error("empty download");
    return new Uint8Array(await data.arrayBuffer());
  },
});

Deno.serve(handler);
