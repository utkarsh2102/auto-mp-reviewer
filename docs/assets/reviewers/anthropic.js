/* Anthropic's Messages API, called straight from the browser with the
 * reviewer's own key. Anthropic answers browser requests only when they carry
 * anthropic-dangerous-direct-browser-access; the name warns against putting
 * one shared key in a page for every visitor. Here each person uses their own
 * key in their own browser, which is the use the header exists for.
 */

import { ReviewError, call, errorFor, events, request } from "./base.js";

const API = "https://api.anthropic.com/v1";

// Error types in a stream's `error` event, as the HTTP status they stand for.
const ERROR_STATUS = {
  invalid_request_error: 400, authentication_error: 401, permission_error: 403,
  not_found_error: 404, rate_limit_error: 429, api_error: 500, overloaded_error: 529,
};

// Each model's output limit, from the Models API, so a request never asks an
// older model for more than it allows.
const limits = new Map();
async function outputLimit(key, model, signal) {
  if (!limits.has(model)) {
    const info = await call(`${API}/models/${encodeURIComponent(model)}`, { headers: headers(key), signal }).catch(() => null);
    limits.set(model, Number(info?.max_tokens) || null);
  }
  return limits.get(model);
}

// Opus 5.x and Fable 5.x can decline requests their safety classifiers flag,
// which security-related diffs sometimes trip. "default" re-runs a declined
// request on Anthropic's recommended fallback model within the same call.
const FALLBACK = /^claude-(opus|fable)-5/;

const headers = (key) => ({
  "x-api-key": key,
  "anthropic-version": "2023-06-01",
  "anthropic-dangerous-direct-browser-access": "true",
});

export const anthropic = {
  id: "anthropic",
  label: "Anthropic (Claude API)",
  keyLabel: "Anthropic API key",
  keyPlaceholder: "sk-ant-…",
  keyUrl: "https://console.anthropic.com/settings/keys",
  keyNote: "A Claude.ai or Claude Code subscription cannot be used here; this needs an API key.",
  defaultModel: "claude-opus-5",
  modelsNeedKey: true,

  async listModels(key, signal) {
    const models = [];
    let after = null;
    do {
      const page = await call(`${API}/models?limit=100${after ? `&after_id=${encodeURIComponent(after)}` : ""}`,
        { headers: headers(key), signal });
      models.push(...(page.data || []).map((m) => ({ id: m.id, label: m.display_name || m.id })));
      after = page.has_more ? page.last_id : null;
    } while (after);
    return models;
  },

  async review({ system, prompt, maxTokens }, { key, model }, signal, onProgress) {
    const limit = await outputLimit(key, model, signal);
    const budget = limit ? Math.min(maxTokens, limit) : maxTokens;
    const fallback = FALLBACK.test(model);
    const res = await request(`${API}/messages`, {
      method: "POST",
      signal,
      headers: { ...headers(key), ...(fallback ? { "anthropic-beta": "server-side-fallback-2026-07-01" } : {}) },
      body: {
        model,
        max_tokens: budget,
        system,
        messages: [{ role: "user", content: prompt }],
        stream: true,
        ...(fallback ? { fallbacks: "default" } : {}),
      },
    });

    let text = "", served = model, stop = null, details = null, input = null, output = null;
    for await (const { event, data } of events(res)) {
      if (event === "message_start") {
        const m = data.message || {};
        served = m.model || served;
        const u = m.usage || {};
        input = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        output = u.output_tokens ?? output;
      } else if (event === "content_block_start") {
        const b = data.content_block || {};
        if (b.type === "thinking" || b.type === "redacted_thinking") onProgress?.("thinking");
        else if (b.type === "text") { onProgress?.("answering"); text += b.text || ""; }
        else if (b.type === "fallback") {
          // The model declined mid-answer and another takes over; what the
          // first one wrote is discarded.
          text = "";
          served = b.to?.model || served;
        }
      } else if (event === "content_block_delta") {
        if (data.delta?.type === "text_delta") text += data.delta.text || "";
      } else if (event === "message_delta") {
        stop = data.delta?.stop_reason ?? stop;
        details = data.delta?.stop_details ?? details;
        output = data.usage?.output_tokens ?? output;
      } else if (event === "error") {
        const e = data.error || {};
        throw errorFor(ERROR_STATUS[e.type] || 500, e.message || "The response stream failed.");
      }
    }

    if (stop === "refusal") {
      throw new ReviewError("refusal", details?.explanation || "The model declined to review this merge proposal.");
    }
    if (stop === "max_tokens" && !text.trim()) {
      throw new ReviewError("truncated", `The model used all ${budget} output tokens, thinking included, without answering.`);
    }
    return { text, model: served, truncated: stop === "max_tokens", usage: { input, output } };
  },
};
