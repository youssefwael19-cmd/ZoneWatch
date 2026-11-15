/**
 * Assistant: LLM, retrieval, and small agents.
 *
 * Provider is deliberately generic — anything that speaks the OpenAI chat
 * completions shape works (Z.ai, OpenAI, Groq, a local proxy). Configure:
 *
 *   AI_API_KEY   required to enable
 *   AI_BASE_URL  default https://api.z.ai/api/paas/v4
 *   AI_MODEL     default glm-4-flash
 *
 * Retrieval ("RAG") is local and dependency-free: the markdown knowledge base
 * is chunked, chunked text is scored against the question with a small BM25
 * style overlap score, and the best chunks are injected into the prompt. No
 * embedding service, no vector database, nothing to keep in sync.
 *
 * The agents are fixed, auditable pipelines: gather live state, retrieve
 * relevant knowledge, ask the model to summarise. The model never invents the
 * numbers — they are passed in.
 */

const fs = require("fs");
const path = require("path");

const KNOWLEDGE_FILES = [
  path.join(__dirname, "knowledge.md"),
  path.join(__dirname, "..", "README.md"),
];

const STOPWORDS = new Set(
  "the a an and or of to in for on with is are was were be been it this that as at by from will would can could should what which who how when where why my me i you your we our they their not no do does did than then there here about into over under more most less least".split(
    " "
  )
);

const store = require("./settings");

/**
 * Configuration resolves in this order: what you saved in the app, then env
 * vars. Defaults point at Groq's free plan, which needs no card.
 */
const settings = {
  saved() {
    try {
      return store.getAiConfig();
    } catch {
      return { apiKey: "", baseUrl: "", model: "" };
    }
  },
  apiKey() {
    return this.saved().apiKey || process.env.AI_API_KEY || "";
  },
  baseUrl() {
    const saved = this.saved().baseUrl;
    const fallback = process.env.AI_BASE_URL || "https://api.groq.com/openai/v1";
    return (saved || fallback).replace(/\/$/, "");
  },
  model() {
    return this.saved().model || process.env.AI_MODEL || "openai/gpt-oss-120b";
  },
  source() {
    if (this.saved().apiKey) return "app";
    if (process.env.AI_API_KEY) return "environment";
    return "none";
  },
};

/* --------------------------- retrieval --------------------------- */

let index = null;

function tokenise(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9.\-]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

function chunkText(text, maxChars = 700) {
  const blocks = String(text).split(/\n\s*\n/);
  const chunks = [];
  let current = "";

  for (const block of blocks) {
    const clean = block.trim();
    if (!clean) continue;
    if ((current + "\n\n" + clean).length > maxChars && current) {
      chunks.push(current.trim());
      current = clean;
    } else {
      current = current ? `${current}\n\n${clean}` : clean;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

function buildIndex() {
  const chunks = [];
  for (const file of KNOWLEDGE_FILES) {
    let text = "";
    try {
      text = fs.readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    for (const chunk of chunkText(text)) {
      const tokens = tokenise(chunk);
      const tf = new Map();
      for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
      chunks.push({ text: chunk, tf, length: tokens.length, source: path.basename(file) });
    }
  }
  const df = new Map();
  for (const c of chunks) for (const term of c.tf.keys()) df.set(term, (df.get(term) || 0) + 1);

  index = { chunks, df, total: chunks.length || 1 };
  return index;
}

function retrieve(question, limit = 4) {
  if (!index) buildIndex();
  if (!index.chunks.length) return [];

  const terms = tokenise(question);
  const scored = index.chunks.map((chunk) => {
    let score = 0;
    for (const term of terms) {
      const tf = chunk.tf.get(term);
      if (!tf) continue;
      const idf = Math.log(1 + index.total / (1 + (index.df.get(term) || 1)));
      score += (tf / (tf + 1.2)) * idf;
    }
    // Mild preference for shorter, denser chunks.
    score = score / Math.sqrt(Math.max(chunk.length, 20) / 120);
    return { ...chunk, score };
  });

  return scored
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/* ----------------------------- the model ---------------------------- */

async function complete(messages, { temperature = 0.2, maxTokens = 700 } = {}) {
  const key = settings.apiKey();
  if (!key) {
    const err = new Error(
      "No AI key configured. Add AI_API_KEY (and optionally AI_BASE_URL, AI_MODEL) as app secrets."
    );
    err.status = 503;
    throw err;
  }

  const res = await fetch(`${settings.baseUrl()}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: settings.model(),
      messages,
      temperature,
      max_tokens: maxTokens,
    }),
    signal: AbortSignal.timeout(45000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(`AI provider responded ${res.status}: ${body.slice(0, 200)}`);
    err.status = 502;
    throw err;
  }

  const data = await res.json();
  const content =
    data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : "";
  return String(content || "").trim();
}

const SYSTEM = [
  "You are the assistant inside Zone Watch, a personal forex and index monitoring app.",
  "Rules you must follow:",
  "- Use the CONTEXT for facts about this app and its measured results. Never invent numbers.",
  "- If the context does not contain the answer, say so plainly instead of guessing.",
  "- Be honest about uncertainty. This app's own testing found no reliable edge; do not imply otherwise.",
  "- Never give financial advice or predict prices. Describe what the data shows.",
  "- Keep answers short and concrete. Plain language, no jargon without explanation.",
].join("\n");

function formatContext(chunks) {
  if (!chunks.length) return "(no relevant notes found)";
  return chunks.map((c, i) => `[${i + 1}] ${c.text}`).join("\n\n");
}

/** Free-form question grounded in the knowledge base and live state. */
async function ask(question, liveState) {
  const chunks = retrieve(question, 4);
  const stateSummary = liveState ? JSON.stringify(liveState).slice(0, 2500) : "{}";

  return complete([
    { role: "system", content: SYSTEM },
    {
      role: "user",
      content:
        `CONTEXT (project notes):\n${formatContext(chunks)}\n\n` +
        `LIVE STATE (current app data):\n${stateSummary}\n\n` +
        `QUESTION: ${question}`,
    },
  ]);
}

/* ------------------------------ agents ------------------------------ */

const AGENTS = {
  briefing: {
    title: "Market briefing",
    instruction:
      "Summarise what matters right now: which markets are near a zone, any active signals, the news blackout or guard status, and which markets the lab currently allows. Three short paragraphs, no preamble.",
  },
  risk: {
    title: "Risk check",
    instruction:
      "Assess current risk posture from the state: open signals, today's closed results against the daily guard, quiet hours, and any markets blocked by the lab. Point out anything that should stop trading. Be brief and direct.",
  },
  coach: {
    title: "Trade coach",
    instruction:
      "Using the measured results in the context, tell the user what their own testing implies about what to focus on. Be blunt about what has no evidence, and name the one or two things most worth trying next. No motivational filler.",
  },
};

async function runAgent(name, liveState) {
  const agent = AGENTS[name];
  if (!agent) {
    const err = new Error(`Unknown agent. Available: ${Object.keys(AGENTS).join(", ")}`);
    err.status = 400;
    throw err;
  }

  const chunks = retrieve(`${agent.title} signals zones risk results evidence`, 4);
  const stateSummary = JSON.stringify(liveState || {}).slice(0, 4000);

  const answer = await complete([
    { role: "system", content: SYSTEM },
    {
      role: "user",
      content:
        `CONTEXT (project notes and measured results):\n${formatContext(chunks)}\n\n` +
        `LIVE STATE:\n${stateSummary}\n\n` +
        `TASK: ${agent.instruction}`,
    },
  ]);

  return { agent: name, title: agent.title, answer };
}

/** A tiny round-trip so the user can prove the key works before relying on it. */
async function testConnection() {
  const reply = await complete(
    [
      { role: "system", content: "Reply with exactly: OK" },
      { role: "user", content: "Connection test." },
    ],
    { temperature: 0, maxTokens: 16 }
  );
  return { reply, model: settings.model(), baseUrl: settings.baseUrl() };
}

function status() {
  if (!index) buildIndex();
  const key = settings.apiKey();
  return {
    enabled: Boolean(key),
    model: settings.model(),
    baseUrl: settings.baseUrl(),
    source: settings.source(),
    keyHint: key ? "••••" + key.slice(-4) : "",
    knowledgeChunks: index ? index.chunks.length : 0,
    agents: Object.entries(AGENTS).map(([id, a]) => ({ id, title: a.title })),
  };
}

module.exports = { ask, runAgent, status, retrieve, buildIndex, testConnection, AGENTS };
