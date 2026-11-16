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
const labMod = require("./lab");
const brainMod = require("./brain");
const journalMod = require("./journal");
const learningMod = require("./learning");
const tracker = require("./signaltracker");
const market = require("./market");

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

/**
 * One provider round-trip. Returns the assistant message verbatim, including
 * any tool calls, because the caller decides whether to run them.
 */
async function chat(messages, { temperature = 0.2, maxTokens = 700, tools = null } = {}) {
  const key = settings.apiKey();
  if (!key) {
    const err = new Error(
      "No AI key configured. Add AI_API_KEY (and optionally AI_BASE_URL, AI_MODEL) as app secrets."
    );
    err.status = 503;
    throw err;
  }

  const payload = {
    model: settings.model(),
    messages,
    temperature,
    max_tokens: maxTokens,
  };
  if (tools && tools.length) {
    payload.tools = tools;
    payload.tool_choice = "auto";
  }

  const res = await fetch(`${settings.baseUrl()}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(45000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(`AI provider responded ${res.status}: ${body.slice(0, 200)}`);
    err.status = 502;
    throw err;
  }

  const data = await res.json();
  const message =
    (data && data.choices && data.choices[0] && data.choices[0].message) || {};
  return {
    content: String(message.content || "").trim(),
    toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : [],
  };
}

/** Text-only reply, for the planner and the connection test. */
async function complete(messages, opts = {}) {
  return (await chat(messages, opts)).content;
}

/* ------------------------------ tools ------------------------------ *
 *
 * The assistant can look things up instead of being handed a summary and
 * asked to be clever with it. Every tool reads the app's own files and live
 * snapshot: no tool invents anything, and a failed tool reports its error
 * back to the model rather than throwing the whole answer away.
 */

const MAX_TOOL_ROUNDS = 4;
const MAX_TOOL_RESULT_CHARS = 4000;

const TOOLS = [
  {
    type: "function",
    function: {
      name: "market_state",
      description:
        "Live prices, zones, signals and gate flags. Pass a symbol for one market, or nothing for all of them.",
      parameters: {
        type: "object",
        properties: { symbol: { type: "string", description: "e.g. NASDAQ or XAUUSD" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "lab_verdict",
      description:
        "The strategy lab's out-of-sample verdict per market: unseen trades, win rate, expectancy, t-stat, and why it passed or failed.",
      parameters: {
        type: "object",
        properties: { symbol: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "brain_status",
      description:
        "The brain's per-market reading: current market condition and the proven rule for it, if any.",
      parameters: {
        type: "object",
        properties: { symbol: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "brain_gate",
      description:
        "Ask the brain whether signals for one market are allowed right now, with its exact reason. Slow: it re-reads candles.",
      parameters: {
        type: "object",
        properties: { symbol: { type: "string" } },
        required: ["symbol"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "journal_summary",
      description:
        "What the app sent and held back: closed trades, win rate, expectancy, failure reasons and the split by trend/bias/session/condition.",
      parameters: {
        type: "object",
        properties: { symbol: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "learning_summary",
      description:
        "The learner's verdicts per market+side+setup, which setups it has muted, and what it held back recently.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "signal_results",
      description:
        "Tracked signals: open count, wins, losses, expiries, win rate, total R and the most recent closes.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "search_notes",
      description:
        "Search the project notes (knowledge.md, README) for measured results, thresholds and documented limits.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  },
];

const TOOL_NAMES = TOOLS.map((t) => t.function.name);

function pickLab(result) {
  if (!result) return null;
  return {
    testedAt: result.at,
    tradable: result.tradable === true,
    verdict: result.verdict,
    unseenTrades: result.oos ? result.oos.n : null,
    winrate: result.oos ? result.oos.winrate : null,
    expectancy: result.oos ? result.oos.expectancy : null,
    tStat: result.tStat,
    positiveFolds: result.positiveFolds,
    required: result.bar,
  };
}

const TOOL_IMPLS = {
  market_state({ symbol } = {}, live) {
    const state = live || {};
    if (!symbol) return state;
    const s = String(symbol).toUpperCase();
    return {
      symbol: s,
      quote: (state.quotes || []).find((q) => q.symbol === s) || null,
      zones: (state.zones || []).filter((z) => z.symbol === s),
      signals: (state.signals || []).filter((x) => x.symbol === s),
      labAllowed: state.labGate ? state.labGate[s] : undefined,
      brain: (state.brain || []).find((b) => b.symbol === s) || null,
      marketOpen: state.marketOpen,
      feed: state.feed,
    };
  },

  lab_verdict({ symbol } = {}) {
    const results = labMod.summary().results || {};
    if (symbol) {
      const s = String(symbol).toUpperCase();
      return { symbol: s, verdict: pickLab(results[s]), tested: Boolean(results[s]) };
    }
    return {
      markets: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, pickLab(v)])),
      neverTested: Object.keys(results).length === 0 ? "nothing tested yet" : undefined,
    };
  },

  brain_status({ symbol } = {}) {
    const conditions = brainMod.summary().conditions || [];
    const rows = conditions.map((c) => ({
      symbol: c.symbol,
      condition: c.condition,
      testedAt: c.at,
      rule: c.champion
        ? {
            name: c.champion.name,
            trades: c.champion.n,
            expectancy: c.champion.expectancy,
            winrate: c.champion.winrate,
            tStat: c.champion.tStat,
            goodFolds: c.champion.goodFolds,
          }
        : null,
    }));
    if (!symbol) return { updatedAt: brainMod.summary().updatedAt, markets: rows };
    const s = String(symbol).toUpperCase();
    return { symbol: s, reading: rows.find((r) => r.symbol === s) || null };
  },

  async brain_gate({ symbol } = {}) {
    const s = String(symbol || "").toUpperCase();
    const inst = market.instrumentList().find((i) => i.symbol === s);
    if (!inst) return { error: `Unknown market "${symbol}". Known: ${market.instrumentList().map((i) => i.symbol).join(", ")}` };
    return brainMod.gate(inst.symbol, inst.candleSymbol);
  },

  journal_summary({ symbol } = {}) {
    const j = journalMod.summary();
    const s = symbol ? String(symbol).toUpperCase() : null;
    return {
      ...j,
      recent: (j.recent || [])
        .filter((e) => !s || e.symbol === s)
        .slice(0, 5)
        .map((e) => ({
          at: e.at,
          symbol: e.symbol,
          side: e.side,
          setup: e.setup,
          status: e.status,
          heldReason: e.heldReason,
          outcome: e.outcome,
          features: e.features,
        })),
      byMarket: s ? (j.byMarket || []).filter((r) => r.label === s) : j.byMarket,
    };
  },

  learning_summary() {
    const l = learningMod.summary();
    return {
      closedTrades: l.closedTrades,
      totalR: l.totalR,
      mutedCount: l.mutedCount,
      muted: l.muted,
      rows: (l.rows || []).map((r) => ({
        symbol: r.symbol,
        side: r.side,
        setup: r.setup,
        n: r.n,
        winrate: r.winrate,
        expectancy: r.expectancy,
        tStat: r.tStat,
        status: r.status,
        note: r.note,
      })),
      suppressed: l.suppressed,
      thresholds: l.thresholds,
    };
  },

  signal_results() {
    const st = tracker.stats();
    return {
      open: st.open,
      wins: st.wins,
      losses: st.losses,
      expired: st.expired,
      winrate: st.winrate,
      totalR: st.totalR,
      recent: (st.recent || []).slice(0, 5).map((h) => ({
        symbol: h.symbol,
        side: h.side,
        outcome: h.outcome,
        rMultiple: h.rMultiple,
        closedAt: h.closedAt,
      })),
    };
  },

  search_notes({ query } = {}) {
    if (!query) return { error: "query is required" };
    return retrieve(query, 4).map((c) => ({ source: c.source, text: c.text }));
  },
};

async function executeTool(name, args, live) {
  const impl = TOOL_IMPLS[name];
  if (!impl) return { error: `Unknown tool "${name}". Available: ${TOOL_NAMES.join(", ")}` };
  try {
    return await impl(args || {}, live);
  } catch (err) {
    return { error: `${name} failed: ${err.message}` };
  }
}

/**
 * The answer loop: let the model call tools until it stops asking for them.
 *
 * If the provider rejects tool calls outright (some models behind these base
 * URLs do), retry once without them rather than failing the question. A tool
 * that throws comes back as an error the model can read and work around.
 */
async function answerWithTools({ messages, live, temperature = 0.3, maxTokens = 1200 }) {
  const msgs = [...messages];
  const used = [];

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const lastRound = round === MAX_TOOL_ROUNDS;
    let reply;
    try {
      reply = await chat(msgs, {
        temperature,
        maxTokens,
        tools: lastRound ? null : TOOLS,
      });
    } catch (err) {
      if (err.status === 502 && round === 0) {
        reply = await chat(msgs, { temperature, maxTokens });
      } else {
        throw err;
      }
    }

    if (!reply.toolCalls.length) {
      return { answer: reply.content, toolsUsed: used };
    }

    msgs.push({ role: "assistant", content: reply.content || "", tool_calls: reply.toolCalls });
    for (const call of reply.toolCalls) {
      const fn = call.function || {};
      let args = {};
      try {
        args = JSON.parse(fn.arguments || "{}");
      } catch {
        args = {};
      }
      const result = await executeTool(fn.name, args, live);
      used.push(fn.name);
      msgs.push({
        role: "tool",
        tool_call_id: call.id || fn.name,
        content: JSON.stringify(result).slice(0, MAX_TOOL_RESULT_CHARS),
      });
    }
  }

  return {
    answer: "I could not finish that within the lookup budget. Ask a narrower question and I will try again.",
    toolsUsed: used,
  };
}

const SYSTEM = [
  "You are the assistant inside Zone Watch, a personal forex and index monitoring app. You are talking with its owner, who wants a real conversation, not a canned summary.",
  "Rules you must follow:",
  "- Use the CONTEXT and LIVE STATE for every fact and number. Never invent prices, trades or results.",
  "- The PLAN is your own earlier reasoning, made before you saw the full context. Follow it, and correct it where the CONTEXT shows it was wrong.",
  "- Answer the question that was actually asked, in the first sentence. Then give the why, with the specific numbers that support it.",
  "- Length follows the question: one line for a simple lookup, a few short paragraphs for an analysis. No filler, no motivational padding.",
  "- If the data needed is missing, name exactly what is missing and what would answer it, instead of guessing.",
  "- If the question is ambiguous in a way that changes the answer, ask one short clarifying question and still give the best partial answer you can.",
  "- Earlier turns in this conversation are context. Use them for follow-ups and do not repeat what you already said unless asked.",
  "- Be honest about uncertainty. This app's own testing found no reliable edge; never imply otherwise.",
  "- Never give financial advice or predict prices. Describe what the data shows.",
  "- Name the gates and numbers the app actually uses (lab verdicts, brain gate, feed, sessions) when they are what explains the answer.",
  "- You have tools that read this app's own files and live snapshot. Call one when the answer needs a number the summary above does not contain. Prefer a lookup over a guess, do not call the same tool twice for the same thing, and say plainly if a tool came back empty.",
].join("\n");

/**
 * The reasoning pass. Runs before the answer and is not shown to the model as
 * prose it must repeat: it is a plan. Two calls instead of one, but a model
 * that has worked out what is being asked — and what it must not claim — stops
 * producing the one-line, half-informed answers a single shot gives.
 */
const PLANNER = [
  "You are the reasoning stage of Zone Watch's assistant. You do not talk to the user; you write the plan the answer stage will follow.",
  "Given the question, the recent conversation, the live app state and retrieved notes, write at most six short lines:",
  "1. What is actually being asked, resolving pronouns and follow-ups from the conversation.",
  "2. Which live-state fields or numbers answer it.",
  "3. Which notes are relevant, or 'none'.",
  "4. What the state and notes do NOT establish, and what must therefore not be claimed.",
  "5. The shape of the best answer: direct answer first, then the why, then at most one next step.",
  "No preamble, no restating the question, no final answer.",
].join("\n");

/* -------------------------- conversation -------------------------- */

// One owner, one conversation. Kept in memory only: it is a train of thought,
// not a record, so a restart should not resurrect stale chatter.
const MAX_TURNS = 8;
const conversation = [];

function remember(role, content) {
  if (!content) return;
  conversation.push({ role, content: String(content).slice(0, 2500) });
  while (conversation.length > MAX_TURNS) conversation.shift();
}

function resetConversation() {
  conversation.length = 0;
}

function recentConversation() {
  return conversation.slice(-MAX_TURNS);
}

function formatContext(chunks) {
  if (!chunks.length) return "(no relevant notes found)";
  return chunks.map((c, i) => `[${i + 1}] ${c.text}`).join("\n\n");
}

/** Merge retrieval results for two queries, keeping the best score per chunk. */
function mergeChunks(a, b, limit) {
  const best = new Map();
  for (const chunk of [...a, ...b]) {
    const seen = best.get(chunk.text);
    if (!seen || chunk.score > seen.score) best.set(chunk.text, chunk);
  }
  return [...best.values()].sort((x, y) => y.score - x.score).slice(0, limit);
}

/**
 * Stage one: think. The plan is returned to the caller so the reasoning is
 * visible and auditable rather than hidden inside a single opaque reply.
 */
async function deliberate(question, stateSummary, context, history = []) {
  const transcript = history.length
    ? history.map((m) => `${m.role === "user" ? "Owner" : "You"}: ${m.content}`).join("\n")
    : "(this is the first question)";

  try {
    const plan = await complete(
      [
        { role: "system", content: PLANNER },
        {
          role: "user",
          content:
            `CONVERSATION SO FAR:\n${transcript}\n\n` +
            `QUESTION: ${question}\n\n` +
            `LIVE STATE (current app data):\n${stateSummary}\n\n` +
            `RETRIEVED NOTES:\n${context}`,
        },
      ],
      { temperature: 0.1, maxTokens: 320 }
    );
    return plan;
  } catch (err) {
    // A missing key must still be reported as missing; any other planning
    // failure should degrade to a direct answer, not a blank screen.
    if (err.status === 503) throw err;
    return "";
  }
}

/**
 * Free-form question: deliberate first, retrieve again using what the planning
 * pass worked out, then answer with the conversation as context.
 */
async function ask(question, liveState) {
  const stateSummary = liveState ? JSON.stringify(liveState).slice(0, 6000) : "{}";
  const history = recentConversation();

  const firstPass = retrieve(question, 5);
  const plan = await deliberate(question, stateSummary, formatContext(firstPass), history);
  const chunks = mergeChunks(firstPass, retrieve(`${question} ${plan}`, 6), 6);

  remember("user", question);

  const { answer, toolsUsed } = await answerWithTools({
    live: liveState,
    temperature: 0.3,
    maxTokens: 1200,
    messages: [
      { role: "system", content: SYSTEM },
      ...history,
      {
        role: "user",
        content:
          `CONTEXT (project notes):\n${formatContext(chunks)}\n\n` +
          `LIVE STATE (current app data):\n${stateSummary}\n\n` +
          (plan ? `PLAN (your own earlier reasoning):\n${plan}\n\n` : "") +
          `QUESTION: ${question}\n\n` +
          `Look anything else up with the tools instead of guessing.`,
      },
    ],
  });

  remember("assistant", answer);
  return {
    answer,
    thinking: plan,
    sources: chunks.map((c) => c.source),
    tools: toolsUsed,
  };
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
  const plan = await deliberate(agent.instruction, stateSummary, formatContext(chunks));

  const target = mergeChunks(chunks, retrieve(`${agent.instruction} ${plan}`, 6), 6);

  const { answer, toolsUsed } = await answerWithTools({
    live: liveState,
    temperature: 0.3,
    maxTokens: 900,
    messages: [
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content:
          `CONTEXT (project notes and measured results):\n${formatContext(target)}\n\n` +
          `LIVE STATE:\n${stateSummary}\n\n` +
          (plan ? `PLAN (your own earlier reasoning):\n${plan}\n\n` : "") +
          `TASK: ${agent.instruction}\n\n` +
          `Look anything else up with the tools instead of guessing.`,
      },
    ],
  });

  return { agent: name, title: agent.title, answer, thinking: plan, tools: toolsUsed };
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
    tools: TOOL_NAMES,
    agents: Object.entries(AGENTS).map(([id, a]) => ({ id, title: a.title })),
  };
}

module.exports = {
  ask,
  runAgent,
  status,
  retrieve,
  buildIndex,
  testConnection,
  resetConversation,
  AGENTS,
};
