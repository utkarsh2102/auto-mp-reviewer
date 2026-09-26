/* OpenRouter's OpenAI-compatible chat completions API: one key for models
 * from many vendors, callable from the browser. */

import { ReviewError, call, errorFor, events, request } from "./base.js";

const API = "https://openrouter.ai/api/v1";

// The most output any endpoint serving a model allows, so a request never asks
// a model for more than it can give (OpenRouter would find no endpoint).
const limits = new Map();
async function outputLimit(model, signal) {
  if (!limits.has(model)) {
    const info = await call(`${API}/models/${model.split(":")[0].split("/").map(encodeURIComponent).join("/")}/endpoints`, { signal }).catch(() => null);
    const caps = (info?.data?.endpoints || []).map((e) => Number(e.max_completion_tokens)).filter((n) => n > 0);
    limits.set(model, caps.length ? Math.max(...caps) : null);
  }
  return limits.get(model);
}

export const openrouter = {
  id: "openrouter",
  label: "OpenRouter",
  keyLabel: "OpenRouter API key",
  keyPlaceholder: "sk-or-…",
  keyUrl: "https://openrouter.ai/settings/keys",
  keyNote: "OpenRouter can cap what each key may spend; a capped key limits what a leaked one costs.",
  defaultModel: "anthropic/claude-opus-5",
  modelsNeedKey: false,

  async listModels(_key, signal) {
    const res = await call(`${API}/models`, { signal });
    return (res.data || []).map((m) => ({ id: m.id, label: m.name || m.id }))
      .sort((a, b) => a.id.localeCompare(b.id));
  },

  async review({ system, prompt, maxTokens }, { key, model }, signal, onProgress) {
    const limit = await outputLimit(model, signal);
    const budget = limit ? Math.min(maxTokens, limit) : maxTokens;
    const res = await request(`${API}/chat/completions`, {
      method: "POST",
      signal,
      headers: {
        authorization: `Bearer ${key}`,
        // OpenRouter's attribution headers: which app is calling.
        "HTTP-Referer": location.origin + location.pathname,
        "X-Title": "Ubuntu MP Review Dashboard",
      },
      body: {
        model,
        max_tokens: budget,
        messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
        stream: true,
        usage: { include: true },
      },
    });

    let text = "", served = model, finish = null, native = null, refusal = null, usage = null;
    for await (const { data } of events(res)) {
      if (data === "[DONE]") break;
      // A failure after the request was accepted arrives inside the stream.
      if (data?.error) throw errorFor(Number(data.error.code) || 0, data.error.message || "The provider reported an error.");
      served = data?.model || served;
      usage = data?.usage || usage;
      const choice = data?.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta || {};
      if (delta.reasoning || delta.reasoning_details?.length) onProgress?.("thinking");
      if (delta.content) { onProgress?.("answering"); text += delta.content; }
      refusal = delta.refusal || refusal;
      finish = choice.finish_reason || finish;
      native = choice.native_finish_reason || native;
    }

    if (finish === "content_filter" || native === "refusal") {
      throw new ReviewError("refusal", refusal || "The model declined to review this merge proposal.");
    }
    if (finish === "length" && !text.trim()) {
      throw new ReviewError("truncated", `The model used all ${budget} output tokens, thinking included, without answering.`);
    }
    return {
      text,
      model: served,
      truncated: finish === "length",
      usage: { input: usage?.prompt_tokens ?? null, output: usage?.completion_tokens ?? null },
    };
  },
};
