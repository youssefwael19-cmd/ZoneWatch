/**
 * Discord delivery.
 *
 * Uses channel webhooks rather than a bot: no token hosting, no privileged
 * intents, and nothing to keep connected. You create a webhook in the Discord
 * channel you want alerts in, paste the URL in Settings, and alerts arrive as
 * rich embeds.
 *
 * You can set one default webhook and optionally override it per purpose:
 *   alerts  - zone alerts, broken zones, guard/feed/heartbeat warnings
 *   signals - signal entries, approach warnings, IVB breakouts
 *   results - wins, losses and expiries
 *   news    - economic calendar warnings and session open/close (falls back
 *             to the default webhook; save a dedicated one to separate it)
 *   daily   - the daily recap sent every day at 21:00 UTC
 *   recap   - the weekly recap and the weekly paper review
 *
 * Webhook URLs are secrets. They are stored server-side and only ever shown
 * back as their last few characters.
 */

const settings = require("./settings");
const pips = require("./pips");

const COLORS = {
  inside: 0xff5f5f, // red
  approaching: 0xffc857, // amber
  near: 0x22d3ee, // cyan
  news: 0xff8a3d, // orange
  info: 0x5fd3a3, // green
  sessionOpen: 0x7aa2ff, // blue
  sessionClose: 0x9b8cff, // purple
};

const CHANNELS = ["alerts", "signals", "results", "news", "daily", "recap"];

function defaultWebhook() {
  return settings.getDiscord() || process.env.DISCORD_WEBHOOK_URL || "";
}

/**
 * Webhook for a purpose, falling back to the default one.
 *
 * Every purpose falls back, news included. Treating news as the exception meant
 * a calendar warning failed with "no webhook saved" while a perfectly good
 * default webhook sat unused — and the test button reported news as broken for
 * no useful reason. A dedicated news webhook still wins when one is saved.
 */
function webhookFor(channel) {
  if (!channel) return defaultWebhook();
  const channels = settings.getDiscordChannels();
  return channels[channel] || defaultWebhook();
}

/** Whether a purpose falls back to the default webhook when it has none. */
function usesDefault(_channel) {
  return true;
}

function channelConfigured(channel) {
  return Boolean(webhookFor(channel));
}

function configured() {
  const channels = settings.getDiscordChannels();
  return Boolean(defaultWebhook()) || CHANNELS.some((c) => Boolean(channels[c]));
}

function status() {
  const url = defaultWebhook();
  const channels = settings.getDiscordChannels();
  const perChannel = {};
  for (const name of CHANNELS) {
    const own = channels[name];
    perChannel[name] = {
      configured: Boolean(own || (usesDefault(name) && url)),
      dedicated: Boolean(own),
      inheritsDefault: usesDefault(name),
      hint: own ? "••••" + own.slice(-6) : "",
    };
  }

  return {
    configured: configured(),
    hint: url ? "••••" + url.slice(-6) : "",
    hasDefault: Boolean(url),
    news: settings.getDiscordNews(),
    sessions: settings.getSessionAlerts(),
    host: url ? safeHost(url) : "",
    channels: perChannel,
  };
}

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function looksLikeDiscord(url) {
  const host = safeHost(url).toLowerCase();
  return host === "discord.com" || host === "discordapp.com" || host.endsWith(".discord.com");
}

/* ------------------------------------------------------------------ *
 * Delivery log — every send attempt, so a silent channel is diagnosable
 * instead of guesswork. Kept in memory, newest last.
 * ------------------------------------------------------------------ */

const deliveries = [];
const MAX_DELIVERIES = 80;

function recordDelivery(entry) {
  deliveries.push({ at: new Date().toISOString(), ...entry });
  if (deliveries.length > MAX_DELIVERIES) deliveries.shift();
}

function getDeliveries() {
  return deliveries.slice(-40).reverse();
}

async function post(payload, channel) {
  const url = webhookFor(channel);
  const kind =
    (payload.embeds && payload.embeds[0] && String(payload.embeds[0].title || "message").slice(0, 40)) ||
    "message";

  if (!url) {
    recordDelivery({ channel: channel || "default", kind, ok: false, error: "no webhook saved" });
    throw new Error(
      channel
        ? `No webhook saved for the ${channel} channel`
        : "No Discord webhook saved"
    );
  }

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(12000),
    });
  } catch (err) {
    recordDelivery({ channel: channel || "default", kind, ok: false, error: err.message });
    throw err;
  }

  if (res.status === 401 || res.status === 403 || res.status === 404) {
    recordDelivery({ channel: channel || "default", kind, ok: false, status: res.status, error: "webhook rejected" });
    throw new Error("Discord rejected the webhook. Check the URL, or delete and recreate the webhook.");
  }
  if (res.status === 429) {
    recordDelivery({ channel: channel || "default", kind, ok: false, status: 429, error: "rate limited" });
    throw new Error("Discord rate limit hit. Alerts will resume shortly.");
  }

  recordDelivery({ channel: channel || "default", kind, ok: res.ok !== false, status: res.status });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Discord responded HTTP ${res.status}${body ? ": " + body.slice(0, 120) : ""}`);
  }
  return true;
}

/** Prices come in wildly different scales (gold 3880, EURUSD 1.10384). */
function levelPrice(value, reference) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  const ref = Math.abs(Number(reference) || n);
  const dp = ref >= 1000 ? 1 : ref >= 100 ? 2 : ref >= 10 ? 3 : 5;
  return n.toFixed(dp);
}

/**
 * One line describing where the volume profile sits and where price is in
 * relation to it. Null when the instrument reports no volume (FX spot).
 */
function valueAreaText(profile, price) {
  if (!profile || profile.poc == null) return null;
  const pos =
    price > profile.vah
      ? "above the value area"
      : price < profile.val
        ? "below the value area"
        : "inside the value area";
  return `POC ${levelPrice(profile.poc, price)} · VA ${levelPrice(profile.val, price)}–${levelPrice(profile.vah, price)} — price is ${pos}`;
}

function money(value, decimals) {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  return Number(value).toFixed(decimals ?? 2);
}

/**
 * Markets that move with the one being alerted.
 *
 * The app sends one alert per moving group so your phone does not buzz twice
 * for the same trade. That used to leave the message silent about the other
 * markets, which is unhelpful when any of them is a valid chart to trade. This
 * names them.
 */
function linkedField(linked) {
  if (!Array.isArray(linked) || !linked.length) return [];
  const names = linked.map((l) => l.symbol).join(", ");
  const recently = linked.filter((l) => l.minutesAgo != null);
  let value = `${names} — same move, so only one alert is sent for the group. Take whichever chart lines up best.`;
  if (recently.length) {
    value += `\nAlready alerted: ${recently.map((l) => `${l.symbol} (${l.minutesAgo}m ago)`).join(", ")}.`;
  }
  return [{ name: "Also moves with", value, inline: false }];
}

async function sendZoneAlert(alert) {
  // Level context: shown as information, not used to filter alerts.
  const levelField =
    alert.levelScore > 0
      ? [
          {
            name: "Structure",
            value: `zone midpoint sits on a level at ${alert.levelPrice} (score ${alert.levelScore})`,
            inline: false,
          },
        ]
      : [];

  const title =
    alert.state === "inside"
      ? "Price is INSIDE the zone"
      : "Price approaching the zone";

  const color = alert.state === "inside" ? COLORS.inside : COLORS.approaching;

  return post(
    {
      username: "Zone Watch",
      embeds: [
        {
          title: `${alert.state === "inside" ? "🔴" : "🟡"} ${title}`,
          description: alert.message,
          color,
          fields: [
            { name: "Instrument", value: alert.symbol, inline: true },
            { name: "Type", value: String(alert.type || "").toUpperCase(), inline: true },
            { name: "Price", value: money(alert.price), inline: true },
            {
              name: "Zone",
              value: alert.low != null && alert.high != null ? `${alert.low} – ${alert.high}` : "—",
              inline: true,
            },
            {
              name: "Distance",
              value:
                alert.distance != null
                  ? `${money(alert.distance, 1)} · ${pips.pipsLabel(alert.symbol, pips.pipsOf(alert.symbol, alert.distance))}`
                  : "—",
              inline: true,
            },
            ...levelField,
            ...linkedField(alert.linked),
            ...(valueAreaText(alert.profile, alert.price)
              ? [
                  {
                    name: "Value area",
                    value: valueAreaText(alert.profile, alert.price),
                    inline: false,
                  },
                ]
              : []),
          ],
          footer: { text: "Zone Watch" },
          timestamp: alert.at || new Date().toISOString(),
        },
      ],
    },
    "alerts"
  );
}

async function sendSignal(signal) {
  const isBuy = signal.side === "BUY";
  const unproven = signal.unproven === true;
  return post(
    {
      username: "Zone Watch",
      embeds: [
        {
          title: `${unproven ? "⚠️ UNPROVEN · " : ""}${isBuy ? "🟢" : "🔴"} ${signal.side} ${signal.symbol} · ${signal.confidence}`,
          description:
            (unproven
              ? `**This market did not pass the app's own edge test.** ${signal.labVerdict || ""}\n` +
                `It is sent because you listed it to bypass the gate. Treat it as a chart prompt, not a recommendation.\n\n`
              : "") +
            (signal.gateBypassed
              ? `**Gate bypassed.** You listed ${signal.symbol} to always send signals: ${signal.gateBypassed}. ` +
                `Auto-trading will not take this one.\n\n`
              : "") +
            (signal.reasons || []).map((r) => `• ${r}`).join("\n"),
          color: isBuy ? COLORS.info : COLORS.inside,
          fields: [
            { name: "Entry", value: String(signal.entry), inline: true },
            { name: "Stop", value: String(signal.stop), inline: true },
            { name: "Target", value: String(signal.target), inline: true },
            {
              name: "Risk",
              value: pips.pipsLabel(
                signal.symbol,
                Math.abs(pips.pipsBetween(signal.symbol, signal.entry, signal.stop)),
                { signed: false }
              ),
              inline: true,
            },
            {
              name: "Reward",
              value: pips.pipsLabel(
                signal.symbol,
                Math.abs(pips.pipsBetween(signal.symbol, signal.entry, signal.target)),
                { signed: false }
              ),
              inline: true,
            },
            {
              name: "Spread",
              // The trade has to clear this before it is a winner. A 4-pip
              // target on a 2-pip spread is not a 4-pip trade.
              value:
                signal.spread && Number.isFinite(Number(signal.spread.units))
                  ? `${pips.pipsLabel(signal.symbol, pips.pipsOf(signal.symbol, signal.spread.units), { signed: false })} · ${signal.spread.source}`
                  : "unknown",
              inline: true,
            },
            {
              name: "Zone",
              value: `${signal.zone.low}–${signal.zone.high} (${signal.zone.type})`,
              inline: true,
            },
            { name: "RR", value: String(signal.riskReward), inline: true },
            ...linkedField(signal.linked),
            ...(signal.sizing
              ? [
                  {
                    name: "Size",
                    value:
                      `${signal.sizing.lots} lots · risk ${signal.sizing.riskActual ?? signal.sizing.riskMoney} ` +
                      `(${signal.sizing.riskPercentActual ?? signal.sizing.riskPercent}%)` +
                      (signal.sizing.warning ? `\n⚠️ ${signal.sizing.warning}` : ""),
                    inline: false,
                  },
                ]
              : []),
            ...(signal.htfTrend ? [{ name: "1h trend", value: signal.htfTrend, inline: true }] : []),
            ...(valueAreaText(signal.profile, signal.entry)
              ? [
                  {
                    name: "Value area",
                    value: valueAreaText(signal.profile, signal.entry),
                    inline: false,
                  },
                ]
              : []),
            ...(signal.confluence
              ? [
                  {
                    name: `Confluence ${signal.confluence.score}/${signal.confluence.total}`,
                    value:
                      signal.confluence.checks
                        .filter((c) => c.ok)
                        .map((c) => c.name)
                        .join(", ") || "none of the checks passed",
                    inline: false,
                  },
                ]
              : []),
          ],
          footer: { text: "Rule-based confluence · not backtested · not financial advice" },
          timestamp: signal.at || new Date().toISOString(),
        },
      ],
    },
    "signals"
  );
}

async function sendSignalApproach(warning) {
  const isBuy = warning.side === "BUY";
  return post(
    {
      username: "Zone Watch",
      embeds: [
        {
          title: `⏳ Approaching a ${isBuy ? "BUY" : "SELL"} setup · ${warning.symbol}`,
          description:
            `Price is **${warning.distance}** away from the ${warning.zone.type} zone ` +
            `**${warning.zone.low}–${warning.zone.high}** (warning band ${warning.band}).\n` +
            `If it reaches the zone, a ${warning.side} signal may follow. Get to the chart now.`,
          color: isBuy ? COLORS.info : COLORS.inside,
          fields: [
            { name: "Instrument", value: warning.symbol, inline: true },
            { name: "Likely side", value: warning.side, inline: true },
            {
              name: "Distance",
              value: `${warning.distance} · ${pips.pipsLabel(warning.symbol, pips.pipsOf(warning.symbol, warning.distance))}`,
              inline: true,
            },
            { name: "Price", value: String(warning.price), inline: true },
            { name: "Zone", value: `${warning.zone.low}–${warning.zone.high}`, inline: true },
            { name: "Source", value: warning.zone.source === "auto" ? "Auto zone" : "Your zone", inline: true },
            ...linkedField(warning.linked),
          ],
          footer: { text: "Early warning, not a signal · Zone Watch" },
          ...(warning.sizing
            ? { fields: [
                { name: "Instrument", value: warning.symbol, inline: true },
                { name: "Likely side", value: warning.side, inline: true },
                {
                  name: "Distance",
                  value: `${warning.distance} · ${pips.pipsLabel(warning.symbol, pips.pipsOf(warning.symbol, warning.distance))}`,
                  inline: true,
                },
                { name: "Price", value: String(warning.price), inline: true },
                { name: "Zone", value: `${warning.zone.low}–${warning.zone.high}`, inline: true },
                { name: "Source", value: warning.zone.source === "auto" ? "Auto zone" : "Your zone", inline: true },
                ...linkedField(warning.linked),
                { name: "Size if it fires", value: `${warning.sizing.lots} lots`, inline: true },
              ] }
            : {}),
          timestamp: warning.at || new Date().toISOString(),
        },
      ],
    },
    "signals"
  );
}

async function sendZoneBroken(info) {
  return post(
    {
      username: "Zone Watch",
      embeds: [
        {
          title: `🔻 Zone broken · ${info.symbol} ${info.type}`,
          description: `Price closed through the ${info.type} zone **${info.low}–${info.high}**, now at ${info.price}. That level has failed — stop waiting on it.`,
          color: COLORS.inside,
          fields: [
            { name: "Instrument", value: info.symbol, inline: true },
            { name: "Zone", value: `${info.low}–${info.high}`, inline: true },
            { name: "Price", value: String(info.price), inline: true },
            { name: "Source", value: info.source === "auto" ? "Auto zone" : "Your zone", inline: true },
          ],
          footer: { text: "Zone Watch" },
          timestamp: new Date().toISOString(),
        },
      ],
    },
    "alerts"
  );
}

async function sendIvb(ivb) {
  const isBuy = ivb.side === "BUY";
  return post(
    {
      username: "Zone Watch",
      embeds: [
        {
          title: `📐 Initial balance break · ${ivb.symbol} ${ivb.side}`,
          description:
            `The first 30 minutes of the New York open ran **${levelPrice(ivb.ibLow, ivb.ibHigh)}–${levelPrice(ivb.ibHigh, ivb.ibHigh)}** ` +
            `(${levelPrice(ivb.range, ivb.ibHigh)} wide). A 5-minute candle closed ${isBuy ? "above" : "below"} it.\n` +
            `Wait for the pullback toward the edge — do not chase the break.`,
          color: isBuy ? COLORS.info : COLORS.inside,
          fields: [
            { name: "Entry (edge)", value: levelPrice(ivb.entry, ivb.entry), inline: true },
            { name: "Stop (other side)", value: levelPrice(ivb.stop, ivb.entry), inline: true },
            { name: "Target 1:2", value: levelPrice(ivb.target, ivb.entry), inline: true },
            {
              name: "Risk",
              value: pips.pipsLabel(ivb.symbol, Math.abs(pips.pipsBetween(ivb.symbol, ivb.entry, ivb.stop)), { signed: false }),
              inline: true,
            },
            {
              name: "Reward",
              value: pips.pipsLabel(ivb.symbol, Math.abs(pips.pipsBetween(ivb.symbol, ivb.entry, ivb.target)), { signed: false }),
              inline: true,
            },
            { name: "Broken at", value: ivb.breakoutAt ? String(ivb.breakoutAt).slice(11, 16) + " UTC" : "—", inline: true },
            {
              name: "Not included",
              value: "Order-flow confirmation (delta, absorption, large prints) is not available on free data — this is the price-structure half of the model only.",
              inline: false,
            },
          ],
          footer: { text: "Valentini IVB model · structure only · Zone Watch" },
          timestamp: new Date().toISOString(),
        },
      ],
    },
    "signals"
  );
}

async function sendDailyGuard(guard) {
  return post(
    {
      username: "Zone Watch",
      embeds: [
        {
          title: "🛑 Daily loss limit reached",
          description: `${guard.reason}\n\nSignal alerts are paused until the next UTC day. Walk away; the market will still be here tomorrow.`,
          color: COLORS.inside,
          fields: [
            { name: "Closed today", value: String(guard.state.closed), inline: true },
            { name: "Wins", value: String(guard.state.wins), inline: true },
            { name: "Losses", value: String(guard.state.losses), inline: true },
            { name: "Day result", value: `${guard.state.totalR}R`, inline: true },
          ],
          footer: { text: "Zone Watch · discipline guard" },
          timestamp: new Date().toISOString(),
        },
      ],
    },
    "alerts"
  );
}

async function sendFeedStale(stale, staleMinutes) {
  const lines = stale
    .slice(0, 10)
    .map((s) => `• **${s.symbol}** — last tick ${s.ageMinutes} min ago${s.price != null ? ` at ${s.price}` : ""}`)
    .join("\n");
  return post(
    {
      username: "Zone Watch",
      embeds: [
        {
          title: "🚨 Price feed has gone quiet",
          description:
            `The market is open, but these prices have not updated in over ${staleMinutes} minutes:\n\n${lines}\n\n` +
            `This is not a trading signal. It means the app is partly blind right now — it cannot see new prices, ` +
            `so it will not spot a setup until the feed returns. Check the data provider, and check your broker ` +
            `directly before doing anything.`,
          color: COLORS.inside,
          footer: { text: "Zone Watch · feed watchdog" },
          timestamp: new Date().toISOString(),
        },
      ],
    },
    "alerts"
  );
}

async function sendFeedRecovered(minutesStale) {
  return post(
    {
      username: "Zone Watch",
      embeds: [
        {
          title: "✅ Price feed is back",
          description:
            `Fresh prices are arriving again after roughly ${minutesStale} minutes without an update. ` +
            `Zone tracking resumes from here — but treat anything that happened during the gap as unseen.`,
          color: COLORS.info,
          footer: { text: "Zone Watch · feed watchdog" },
          timestamp: new Date().toISOString(),
        },
      ],
    },
    "alerts"
  );
}

async function sendHealthAlert(component, detail) {
  const titles = {
    discord: "🚨 Discord delivery is failing",
    feed: "🚨 Price feed has gone quiet",
  };
  const bodies = {
    discord:
      "The app tried to send to Discord and the webhook rejected it. Until this is fixed, nothing reaches your phone.\n\n" +
      "Open Settings → Discord alerts, press the test button, and re-paste the webhook if it has been deleted or recreated.",
    feed:
      "The market is open but prices have stopped updating, so the app cannot see new setups. Check the data provider.",
  };
  return post(
    {
      username: "Zone Watch",
      embeds: [
        {
          title: titles[component] || `🚨 ${component} is unhealthy`,
          description: (bodies[component] || "A part of the app is not healthy.") + (detail ? `\n\n${detail}` : ""),
          color: COLORS.inside,
          footer: { text: "Zone Watch · health monitor" },
          timestamp: new Date().toISOString(),
        },
      ],
    },
    "alerts"
  );
}

async function sendHealthRecovered(component, minutes) {
  return post(
    {
      username: "Zone Watch",
      embeds: [
        {
          title: `✅ ${component} is healthy again`,
          description:
            `This was broken for about ${minutes} minutes and has recovered on its own. ` +
            `Anything that happened during the gap was not seen.`,
          color: COLORS.info,
          footer: { text: "Zone Watch · health monitor" },
          timestamp: new Date().toISOString(),
        },
      ],
    },
    "alerts"
  );
}

/** "17:26 UTC" from an ISO stamp, for the offline window in the gap alert. */
function utcClock(iso) {
  const at = new Date(iso);
  if (!iso || Number.isNaN(at.getTime())) return null;
  return at.toISOString().slice(11, 16) + " UTC";
}

/**
 * The gap alert fires only after 15+ minutes of silence, which a process that
 * crashes and restarts in seconds can never produce. So the cause is always the
 * host being off, not "restarting too often" — say so, and name the real one.
 */
async function sendWatcherGap(gapMinutes, span) {
  const { from = null, to = null } = span || {};
  const start = utcClock(from);
  const end = utcClock(to);
  const window = start && end ? ` It was off from **${start}** to **${end}**.` : "";
  const onFly = Boolean(process.env.FLY_APP_NAME || process.env.FLY_MACHINE_ID);
  // Render sets RENDER=true on every service. A Free web service (and any
  // instance that is out of hours or suspended) stops on idle, which reads as
  // exactly this gap; a paid instance does not.
  const onRender = Boolean(process.env.RENDER);
  const cause = onFly
    ? "A gap that long is the host being stopped, not a restart loop. Fly's trial plan stops the machine five minutes after it starts, and it only comes back when something requests the app. Adding a payment method at https://fly.io/trial is what makes it run continuously."
    : onRender
      ? "A gap that long is the host being stopped, not a restart loop. On Render this happens when the service is on the Free plan (it spins down after 15 minutes without traffic), is suspended for a billing or usage limit, or is mid-deploy. A paid instance (0.5 CPU / 512 MB or larger) with a disk stays up. Check the service's Events tab at https://dashboard.render.com."
      : "A gap that long is the host being stopped or asleep, not a restart loop — a crash that comes straight back would be seconds, not minutes. Check whether the container is being stopped for inactivity.";

  return post(
    {
      username: "Zone Watch",
      embeds: [
        {
          title: "⚠️ Watcher was offline",
          description: `The bot did not check the market for about **${gapMinutes} minutes**.${window} Any alerts during that window were missed.\n\n${cause}`,
          color: COLORS.approaching,
          footer: { text: "Zone Watch · heartbeat" },
          timestamp: new Date().toISOString(),
        },
      ],
    },
    "alerts"
  );
}

async function sendSignalResult(result) {
  const won = result.outcome === "win";
  const expired = result.outcome === "expired";
  const emoji = won ? "✅" : expired ? "⚪" : "❌";
  const title = won ? "Signal WON" : expired ? "Signal expired" : "Signal LOST";
  const colour = won ? COLORS.info : expired ? COLORS.near : COLORS.inside;

  // Pips the price moved, then what the broker took, then what was left.
  const movedPips = Math.abs(pips.pipsBetween(result.symbol, result.entry, result.exit) ?? 0);
  const grossPips = expired ? pips.pipsBetween(result.symbol, result.entry, result.exit) ?? 0 : won ? movedPips : -movedPips;
  const spreadPips =
    result.spread && Number.isFinite(Number(result.spread.units))
      ? Math.abs(pips.pipsOf(result.symbol, result.spread.units) ?? 0)
      : 0;
  // The spread is paid either way: it eats into a winner and deepens a loser,
  // which is exactly how a "win" that barely beat the spread is not a win.
  const netPips = Number((grossPips - spreadPips).toFixed(1));

  const riskPips = Math.abs(pips.pipsBetween(result.symbol, result.entry, result.stop) ?? 0);
  const netR = riskPips > 0 ? netPips / riskPips : result.rMultiple;

  // Money, when the signal carried a position size: 1R is exactly the money
  // risked, so net R times risk is what the account actually gained or lost.
  const riskMoney = Number(result.sizing && result.sizing.riskMoney);
  const moneyField =
    result.sizing && Number.isFinite(riskMoney) && riskMoney > 0
      ? [
          {
            name: "Money",
            value: `${netR < 0 ? "-" : "+"}$${Math.abs(netR * riskMoney).toFixed(2)}${
              result.sizing.lots != null ? ` · ${result.sizing.lots} lots` : ""
            }`,
            inline: true,
          },
        ]
      : [];

  return post(
    {
      username: "Zone Watch",
      embeds: [
        {
          title: `${emoji} ${title} · ${result.side} ${result.symbol}`,
          description: won
            ? `Target reached. +${result.rMultiple}R`
            : expired
              ? `Closed without hitting target or stop after ${Math.round((result.heldMinutes || 0) / 60)}h.`
              : `Stop hit. ${result.rMultiple}R`,
          color: colour,
          fields: [
            { name: "Entry", value: String(result.entry), inline: true },
            { name: "Exit", value: String(result.exit), inline: true },
            {
              name: "Result",
              value: `${result.rMultiple > 0 ? "+" : ""}${result.rMultiple}R`,
              inline: true,
            },
            { name: "Pips", value: pips.pipsLabel(result.symbol, grossPips), inline: true },
            {
              name: "Spread",
              value: spreadPips ? pips.pipsLabel(result.symbol, -spreadPips) : "not recorded",
              inline: true,
            },
            {
              name: "Net",
              value: `${pips.pipsLabel(result.symbol, netPips)} (${netR > 0 ? "+" : ""}${netR.toFixed(2)}R)`,
              inline: true,
            },
            ...moneyField,
            { name: "Stop", value: String(result.stop), inline: true },
            { name: "Target", value: String(result.target), inline: true },
            { name: "Held", value: `${result.heldMinutes || 0} min`, inline: true },
          ],
          footer: { text: "Zone Watch · outcome tracked from the live price" },
          timestamp: result.closedAt || new Date().toISOString(),
        },
      ],
    },
    "results"
  );
}

async function sendSessionEvent(event) {
  const opening = event.type === "open";
  return post(
    {
      username: "Zone Watch",
      embeds: [
        {
          title: `${opening ? "🟦" : "🟪"} ${event.name} session ${opening ? "OPEN" : "CLOSED"}`,
          description: event.detail
            ? event.detail
            : opening
              ? `${event.name} is now open (since ${event.time}). Closes around ${event.closeTime}.`
              : `${event.name} has closed (at ${event.time}). Opens again around ${event.openTime || "next session"}.`,
          color: opening ? COLORS.sessionOpen : COLORS.sessionClose,
          fields: [
            { name: "Session", value: event.name, inline: true },
            { name: "Event", value: opening ? "Open" : "Close", inline: true },
          ],
          footer: { text: "Zone Watch · session times are approximate (UTC-based)" },
          timestamp: event.at || new Date().toISOString(),
        },
      ],
    },
    "news"
  );
}

async function sendNewsRisk(events) {
  const list = events
    .map((e) => `• **${e.title}** (${e.country}, ${e.impact}) in ${e.minutesUntil} min`)
    .join("\n");

  return post(
    {
      username: "Zone Watch",
      embeds: [
        {
          title: "🟠 News risk: high-impact event soon",
          description: `${list}\n\nConsider flattening or standing aside until it passes.`,
          color: COLORS.news,
          footer: { text: "Zone Watch" },
          timestamp: new Date().toISOString(),
        },
      ],
    },
    "news"
  );
}

async function sendWeeklyRecap(recap) {
  const start = new Date(recap.periodStart).toISOString().slice(0, 10);
  const end = new Date(recap.periodEnd).toISOString().slice(0, 10);

  const perSymbol = Object.entries(recap.bySymbol || {})
    .map(
      ([sym, s]) =>
        `• **${sym}** — ${s.wins}W / ${s.losses}L${s.expired ? ` / ${s.expired} expired` : ""} (${s.r > 0 ? "+" : ""}${s.r.toFixed(2)}R)`
    )
    .join("\n");

  const lines = [];
  if (recap.total === 0) {
    lines.push("No signals were closed this week. Nothing to report.");
  } else {
    lines.push(`**${recap.total} closed signals this week**`);
    lines.push(
      `✅ ${recap.wins} won · ❌ ${recap.losses} lost` + (recap.expired ? ` · ⚪ ${recap.expired} expired` : "")
    );
    if (recap.winrate != null) lines.push(`Winrate: **${recap.winrate}%**`);
    lines.push(`Total: **${recap.totalR > 0 ? "+" : ""}${recap.totalR}R**`);
  }

  const fields = [];
  if (perSymbol) fields.push({ name: "By instrument", value: perSymbol, inline: false });
  if (recap.best) {
    fields.push({
      name: "Best trade",
      value: `${recap.best.side} ${recap.best.symbol} · +${recap.best.rMultiple}R`,
      inline: true,
    });
  }
  if (recap.worst) {
    fields.push({
      name: "Worst trade",
      value: `${recap.worst.side} ${recap.worst.symbol} · ${recap.worst.rMultiple}R`,
      inline: true,
    });
  }

  return post(
    {
      username: "Zone Watch",
      embeds: [
        {
          title: `📊 Weekly recap · ${start} → ${end}`,
          description: lines.join("\n"),
          color: recap.totalR >= 0 ? COLORS.info : COLORS.inside,
          fields,
          footer: { text: "Zone Watch · outcomes tracked from live prices" },
          timestamp: new Date().toISOString(),
        },
      ],
    },
    "recap"
  );
}

/** Send a test to every configured channel and report each result. */
async function testAllChannels() {
  const results = [];
  for (const name of CHANNELS) {
    if (!webhookFor(name)) {
      results.push({ channel: name, ok: false, error: "no webhook saved" });
      continue;
    }
    try {
      await sendTest(name);
      results.push({ channel: name, ok: true });
    } catch (err) {
      results.push({ channel: name, ok: false, error: err.message });
    }
  }
  return results;
}

async function sendTest(channel) {
  // An explicit channel must use its own webhook; substituting another channel
  // would make a news test land in alerts and read as a pass.
  const target = channel || CHANNELS.find((c) => webhookFor(c));
  const url = webhookFor(target);
  if (!url) {
    throw new Error(
      channel
        ? `No webhook saved for the ${channel} channel. Paste one and save it first.`
        : "Save a webhook URL first"
    );
  }
  if (!looksLikeDiscord(url)) {
    throw new Error(
      "That does not look like a Discord webhook URL. Copy it from Channel settings → Integrations → Webhooks."
    );
  }

  return post(
    {
      username: "Zone Watch",
      embeds: [
        {
          title: "✅ Connection test",
          description: `Alerts from Zone Watch will arrive in this channel${target ? ` (${target})` : ""}. You are set up correctly.`,
          color: COLORS.info,
          footer: { text: "Zone Watch" },
          timestamp: new Date().toISOString(),
        },
      ],
    },
    target
  );
}

module.exports = {
  post,
  configured,
  channelConfigured,
  status,
  webhookUrl: defaultWebhook,
  webhookFor,
  looksLikeDiscord,
  sendZoneAlert,
  sendSignal,
  linkedField,
  getDeliveries,
  testAllChannels,
  sendSignalApproach,
  sendZoneBroken,
  sendIvb,
  sendDailyGuard,
  sendWatcherGap,
  sendFeedStale,
  sendHealthAlert,
  sendHealthRecovered,
  sendFeedRecovered,
  sendSignalResult,
  sendWeeklyRecap,
  sendNewsRisk,
  sendSessionEvent,
  sendTest,
  CHANNELS,
};
