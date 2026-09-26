/* LLM review providers.
 *
 * Mirrors scripts/providers/: every LLM service sits behind one contract, so
 * the rest of the dashboard never knows which one answers. A provider is an
 * object with:
 *
 *   id, label                   stored with each cached review / shown in settings
 *   keyLabel, keyPlaceholder,   the key field in the settings dialog, and where
 *   keyUrl, keyNote             to create a key
 *   defaultModel                used until someone picks another
 *   modelsNeedKey               whether listModels needs the key
 *   listModels(key, signal)     -> [{ id, label }]
 *   review({ system, prompt, maxTokens }, { key, model }, signal, onProgress)
 *                               -> { text, model, truncated, usage: { input, output } }
 *                               Streams the answer, calling onProgress("thinking")
 *                               or onProgress("answering") as the model moves on.
 *                               maxTokens is a ceiling on everything the model
 *                               writes, thinking included; clamp it to the
 *                               model's own limit.
 *
 * Both calls throw ReviewError (./base.js) so the UI can explain a failure
 * without parsing provider messages.
 *
 * Adding a provider: write a module exporting such an object, list it below,
 * and allow its API host in the Content-Security-Policy (connect-src) in
 * docs/index.html; the browser refuses every other host.
 */

import { anthropic } from "./anthropic.js";
import { openrouter } from "./openrouter.js";

export { ReviewError } from "./base.js";

export const REVIEWERS = [anthropic, openrouter];

export const getReviewer = (id) => REVIEWERS.find((r) => r.id === id) || null;
