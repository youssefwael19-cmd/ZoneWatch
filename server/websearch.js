/**
 * Internet search for the assistant.
 *
 * Exa's search REST API returns ranked titles, URLs and text excerpts, which is
 * what a language model needs to answer "what happened today" without inventing
 * it. The key lives on the server (settings or EXA_API_KEY) and never reaches
 * the browser. With no key the tool says so plainly instead of silently failing,
 * because an assistant that cannot search should admit it rather than imply it
 * did.
 */

const settings = require("./settings");

const ENDPOINT = "https://api.exa.ai/search";
const MAX_RESULTS = 6;
const TIMEOUT_MS = 15000;

function apiKey() {
  const stored = settings.getWebSearchKey();
  return String(stored || process.env.EXA_API_KEY || "").trim();
}

function status() {
  const key = apiKey();
  return {
    provider: "exa",
    configured: Boolean(key),
    source: settings.getWebSearchKey() ? "app" : process.env.EXA_API_KEY ? "env" : "none",
    keyHint: key ? "••••" + key.slice(-4) : "",
  };
}

/**
 * @returns {Promise<{ok: boolean, query: string, results?: Array, error?: string}>}
 */
async function search(query, { numResults = 5 } = {}) {
  const q = String(query || "").trim().slice(0, 400);
  if (!q) return { ok: false, query: q, error: "a search query is required" };

  const key = apiKey();
  if (!key) {
    return {
      ok: false,
      query: q,
      error: "web search is not configured: add an Exa API key in the assistant settings",
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key },
      body: JSON.stringify({
        query: q,
        numResults: Math.min(Math.max(Number(numResults) || 5, 1), MAX_RESULTS),
        type: "auto",
        contents: { text: { maxCharacters: 500 } },
      }),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        ok: false,
        query: q,
        error: data.error || data.message || `the search provider returned ${res.status}`,
      };
    }
    const results = (data.results || []).map((row) => ({
      title: row.title || "",
      url: row.url || "",
      published: row.publishedDate || null,
      snippet: String(row.text || row.summary || "").replace(/\s+/g, " ").slice(0, 500),
    }));
    return { ok: true, query: q, results };
  } catch (err) {
    const reason = err.name === "AbortError" ? "the search timed out" : err.message;
    return { ok: false, query: q, error: reason };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { search, status, apiKey };
