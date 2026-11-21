/**
 * One place that says how many trades each book has.
 *
 * The dashboard had three honest panels that disagreed: performance said four
 * closed, the journal said none, the shadow book said two. Each was right about
 * its own book and none of them said which book it was counting, so the screen
 * read as broken arithmetic.
 *
 * This module does not merge the books — a refused signal and a placed order are
 * not the same event, and pretending otherwise is the dishonesty the rest of the
 * app avoids. It counts them side by side, names them, and reports the one thing
 * that would be a genuine loss: a tracked result that never reached the journal.
 */

const CLOSED = new Set(["win", "loss", "breakeven"]);

function isClosed(row) {
  return CLOSED.has(row && row.outcome);
}

function count(rows, predicate) {
  return (rows || []).filter(predicate).length;
}

/**
 * @param {object} input
 * @param {{open: Array, history: Array}} input.tracker   signaltracker.load()
 * @param {Array} input.journal                            journal.readJournal().entries
 * @param {object} [input.executor]                        executor.status()
 * @param {object} [input.shadow]                          shadow.status()
 */
function reconcile({ tracker, journal, executor, shadow } = {}) {
  const open = (tracker && tracker.open) || [];
  const history = (tracker && tracker.history) || [];
  const entries = journal || [];

  const trackedClosed = count(history, isClosed);
  const trackedOther = history.length - trackedClosed; // expiries

  const sent = entries.filter((e) => e.status !== "held");
  const held = entries.filter((e) => e.status === "held");
  const journalClosed = count(sent, isClosed);
  const heldResolved = count(held, isClosed);
  const journalResolved = journalClosed + heldResolved;

  const live = {
    open: (executor && executor.openCount) || 0,
    closed: (executor && executor.closedCount) || 0,
  };
  const shadowBook = {
    open: (shadow && shadow.openCount) || 0,
    closed: (shadow && shadow.closedCount) || 0,
    refusedToday: (shadow && shadow.refusedToday) || 0,
  };

  // Gaps in both directions, because both are real things to know about:
  // a tracked result with no entry is evidence the dashboard is not showing,
  // and an entry with no tracked result is a record of a signal the tracker
  // never scored (posted before tracking existed, or a reset tracker).
  const missing = Math.max(0, trackedClosed - journalResolved);
  const extra = Math.max(0, journalResolved - trackedClosed);
  const gaps = [];
  if (missing) {
    gaps.push(
      `${missing} tracked result${missing === 1 ? "" : "s"} closed without a journal entry — the journal back-fills those on the next start`
    );
  }
  if (extra) {
    gaps.push(
      `${extra} journal entr${extra === 1 ? "y" : "ies"} closed with no tracked signal behind ${extra === 1 ? "it" : "them"} — recorded before tracking, or the tracker was reset`
    );
  }

  return {
    books: {
      // Signals: what the app decided, delivered or not.
      signals: { open: open.length, closed: trackedClosed, expired: trackedOther },
      // The live/paper account: what was actually ordered.
      live,
      // The shadow book: what the gate's refusals would have been worth.
      shadow: shadowBook,
    },
    journal: {
      logged: entries.length,
      sent: sent.length,
      held: held.length,
      closedDelivered: journalClosed,
      heldResolved,
      open: count(sent, (e) => e.outcome == null),
    },
    consistent: gaps.length === 0,
    gaps,
    note:
      "Signals are what the app decided (delivered or held back); live is what was ordered; shadow is what the refusals would have paid. They are different books and are counted apart on purpose.",
  };
}

module.exports = { reconcile, isClosed };
