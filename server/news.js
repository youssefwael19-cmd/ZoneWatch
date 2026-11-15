/**
 * News and economic-calendar watcher.
 *
 * Two free, key-less sources:
 *   1. Economic calendar JSON (ForexFactory-style weekly feed)
 *   2. Headlines from financial RSS feeds
 *
 * Everything is cached so the app does not hammer the feeds, and every
 * network failure degrades to "we could not check news right now" instead
 * of breaking the dashboard.
 */

const CALENDAR_URL =
  process.env.CALENDAR_URL || "https://nfs.faireconomy.media/ff_calendar_thisweek.json";

const RSS_FEEDS = [
  { name: "FXStreet", url: "https://www.fxstreet.com/rss/news" },
  { name: "Investing.com", url: "https://www.investing.com/rss/news_1.rss" },
];

// Currencies that move gold and the Nasdaq.
const RELEVANT_COUNTRIES = new Set(["USD", "US"]);

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MINUTES_BEFORE_EVENT = 30; // "news risk" window

const cache = {
  calendar: { at: 0, data: null, error: null },
  headlines: { at: 0, data: null, error: null },
};

const IMPACT_ORDER = { high: 3, medium: 2, low: 1, holiday: 0 };

function impactRank(impact) {
  const key = String(impact || "").toLowerCase().trim();
  return IMPACT_ORDER[key] ?? 1;
}

/**
 * The calendar feed uses varying shapes across mirrors. This normalises
 * whatever we get into a consistent event object.
 */
function normaliseEvent(raw) {
  const title = raw.title || raw.event || raw.name;
  if (!title) return null;

  let when = raw.date || raw.datetime || raw.timestamp || raw.time;
  if (typeof when === "number") {
    // Some feeds use unix seconds, some milliseconds.
    when = new Date(when < 1e12 ? when * 1000 : when);
  }
  const date = when ? new Date(when) : null;
  if (!date || Number.isNaN(date.getTime())) return null;

  const country = String(raw.country || raw.currency || "").toUpperCase();

  return {
    title: String(title).trim(),
    country,
    impact: String(raw.impact || "medium").toLowerCase(),
    date: date.toISOString(),
    forecast: raw.forecast != null ? String(raw.forecast) : "",
    previous: raw.previous != null ? String(raw.previous) : "",
  };
}

async function fetchCalendar() {
  if (Date.now() - cache.calendar.at < CACHE_TTL_MS && cache.calendar.data) {
    return cache.calendar;
  }

  try {
    const res = await fetch(CALENDAR_URL, {
      signal: AbortSignal.timeout(12000),
      headers: { "User-Agent": "trading-agent/1.0" },
    });
    if (!res.ok) throw new Error(`Calendar HTTP ${res.status}`);

    const text = await res.text();
    let rows;
    try {
      rows = JSON.parse(text);
    } catch {
      throw new Error("Calendar feed was not valid JSON");
    }
    if (!Array.isArray(rows)) throw new Error("Calendar feed had an unexpected shape");

    const events = rows.map(normaliseEvent).filter(Boolean);
    cache.calendar = { at: Date.now(), data: events, error: null };
  } catch (err) {
    cache.calendar = {
      at: Date.now(),
      data: cache.calendar.data || [],
      error: err.message,
    };
  }

  return cache.calendar;
}

function stripTags(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function parseRss(xml, sourceName) {
  const items = [];
  const blocks = xml.split(/<item[\s>]/i).slice(1);
  for (const block of blocks.slice(0, 8)) {
    const title = block.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const link = block.match(/<link[^>]*>([\s\S]*?)<\/link>/i);
    const date = block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i);
    if (!title) continue;
    const published = date ? new Date(stripTags(date[1])) : null;
    items.push({
      title: stripTags(title[1]),
      link: link ? stripTags(link[1]) : "",
      source: sourceName,
      published: published && !Number.isNaN(published.getTime())
        ? published.toISOString()
        : null,
    });
  }
  return items;
}

async function fetchHeadlines() {
  if (Date.now() - cache.headlines.at < CACHE_TTL_MS && cache.headlines.data) {
    return cache.headlines;
  }

  const results = await Promise.all(
    RSS_FEEDS.map(async (feed) => {
      try {
        const res = await fetch(feed.url, {
          signal: AbortSignal.timeout(10000),
          headers: { "User-Agent": "trading-agent/1.0" },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const xml = await res.text();
        return { items: parseRss(xml, feed.name), error: null, name: feed.name };
      } catch (err) {
        return { items: [], error: `${feed.name}: ${err.message}`, name: feed.name };
      }
    })
  );

  const items = results
    .flatMap((r) => r.items)
    .sort((a, b) => new Date(b.published || 0) - new Date(a.published || 0))
    .slice(0, 30);

  const errors = results.filter((r) => r.error).map((r) => r.error);

  cache.headlines = {
    at: Date.now(),
    data: items,
    error: errors.length === results.length ? errors.join("; ") : null,
  };

  return cache.headlines;
}

/**
 * The combined news picture for the dashboard:
 *  - upcoming relevant events, soonest first
 *  - whether we are inside a news-risk window right now
 *  - recent headlines
 */
async function getNewsSummary() {
  const [calendar, headlines] = await Promise.all([fetchCalendar(), fetchHeadlines()]);
  const now = Date.now();

  const relevant = (calendar.data || [])
    .filter((e) => RELEVANT_COUNTRIES.has(e.country))
    .map((e) => {
      const ms = new Date(e.date).getTime() - now;
      return {
        ...e,
        minutesUntil: Math.round(ms / 60000),
        isPast: ms < 0,
      };
    })
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  const upcoming = relevant.filter((e) => !e.isPast && e.minutesUntil <= 24 * 60);

  const highImpactSoon = relevant.filter(
    (e) =>
      !e.isPast &&
      e.minutesUntil <= MINUTES_BEFORE_EVENT &&
      impactRank(e.impact) >= 3
  );

  return {
    ok: true,
    checkedAt: new Date().toISOString(),
    calendarError: calendar.error,
    headlinesError: headlines.error,
    windowMinutes: MINUTES_BEFORE_EVENT,
    highImpactSoon,
    newsRisk: highImpactSoon.length > 0,
    upcoming: upcoming.slice(0, 25),
    headlines: headlines.data || [],
  };
}

/**
 * News blackout: are we within `minutes` either side of a high-impact USD
 * event? Used to suppress signals around releases, when a stop can be jumped
 * by a spike rather than reached by price action.
 */
async function getBlackout(minutes = 15) {
  const calendar = await fetchCalendar();
  const now = Date.now();
  const windowMs = Math.max(1, Number(minutes) || 15) * 60000;

  const active = (calendar.data || [])
    .filter((e) => RELEVANT_COUNTRIES.has(e.country) && impactRank(e.impact) >= 3)
    .map((e) => {
      const ms = new Date(e.date).getTime() - now;
      return { title: e.title, date: e.date, impact: e.impact, msUntil: ms };
    })
    .filter((e) => Math.abs(e.msUntil) <= windowMs)
    .sort((a, b) => Math.abs(a.msUntil) - Math.abs(b.msUntil));

  return {
    active: active.length > 0,
    minutes,
    events: active.map((e) => ({
      title: e.title,
      date: e.date,
      impact: e.impact,
      minutesUntil: Math.round(e.msUntil / 60000),
    })),
  };
}

module.exports = { getNewsSummary, getBlackout };
