/* What every LLM review provider shares: the error type the UI understands,
 * and one HTTP helper that maps the failures all providers have in common.
 *
 * ReviewError.kind is one of:
 *   config      no provider or key is set up
 *   auth        the key was rejected
 *   credits     the account behind the key has no credit left
 *   rate_limit  too many requests; `retryAfter` (seconds) when the provider says
 *   too_large   the request does not fit the model's context window
 *   refusal     the model declined to answer
 *   truncated   the model used its whole output allowance (thinking included)
 *               before it said anything
 *   unavailable the provider is overloaded or down
 *   network     the request never got an answer
 *   context     the MP's review context could not be loaded from this site
 *   provider    anything else the provider reported
 */

export class ReviewError extends Error {
  constructor(kind, message, { status = null, retryAfter = null } = {}) {
    super(message);
    this.name = "ReviewError";
    this.kind = kind;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

// A provider's error message, from the shapes the common APIs use.
function messageOf(data, text, res) {
  const e = data?.error;
  return (typeof e === "string" ? e : e?.message) || data?.message
    || (text || "").slice(0, 300) || `HTTP ${res.status} ${res.statusText}`;
}

export function errorFor(status, message, retryAfter = null) {
  const extra = { status, retryAfter };
  if (status === 401 || status === 403) return new ReviewError("auth", message, extra);
  if (status === 402 || /credit balance|insufficient (credits|funds|balance)/i.test(message)) {
    return new ReviewError("credits", message, extra);
  }
  if (status === 429) return new ReviewError("rate_limit", message, extra);
  if (status === 413 || /context (length|window)|too (long|large)|maximum context|prompt is too long/i.test(message)) {
    return new ReviewError("too_large", message, extra);
  }
  if (status >= 500) return new ReviewError("unavailable", message, extra);
  return new ReviewError("provider", message, extra);
}

// fetch() a provider's API, turning a failed request or an error status into
// a ReviewError. Credentials are never sent (the key goes in a header the
// caller sets) and only the page's origin is sent as referrer.
export async function request(url, { method = "GET", headers = {}, body, signal } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
      credentials: "omit",
      referrerPolicy: "origin",
    });
  } catch (err) {
    if (err.name === "AbortError") throw err;
    throw new ReviewError("network", err.message || "The request failed.");
  }
  if (!res.ok) {
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    // Retry-After is only readable when the provider exposes it to CORS.
    throw errorFor(res.status, messageOf(data, text, res), Number(res.headers.get("retry-after")) || null);
  }
  return res;
}

// A JSON API call.
export async function call(url, options) {
  const res = await request(url, options);
  try {
    return await res.json();
  } catch {
    throw new ReviewError("provider", "The provider's answer was not JSON.");
  }
}

// The server-sent events of a streaming response, as { event, data }, with
// data parsed when it is JSON. Reviews stream because a model may think for
// minutes before it answers, longer than a plain request should wait.
export async function* events(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";  // text with line ends normalised, not yet split into events
  let carry = "";   // a final "\r" whose "\n" may arrive with the next chunk
  for (;;) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch (err) {
      if (err.name === "AbortError") throw err;
      throw new ReviewError("network", "The connection dropped while the model was answering.");
    }
    let text = carry + decoder.decode(chunk.value || new Uint8Array(), { stream: !chunk.done });
    carry = !chunk.done && text.endsWith("\r") ? "\r" : "";
    if (carry) text = text.slice(0, -1);
    buffer += text.replace(/\r\n?/g, "\n");
    let end;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let event = "message";
      const data = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(line.startsWith("data: ") ? 6 : 5));
      }
      if (!data.length) continue;  // a comment or keep-alive
      const payload = data.join("\n");
      let parsed = payload;
      try { parsed = JSON.parse(payload); } catch { /* keep the text, e.g. [DONE] */ }
      yield { event, data: parsed };
    }
    if (chunk.done) return;
  }
}
