/**
 * ledger.mjs — the append-only record of what the brief did and what it cost.
 *
 * WHY THIS EXISTS AND WHY IT IS FIRST
 *
 * Four loops are planned: complexity calibration, source quality, deep-dive hit
 * rate, and the Analys track record. Not one of them can look backwards without
 * a record, and a record cannot be written retroactively. Every day this file is
 * absent is a day that is permanently unavailable to every loop.
 *
 * So it ships before anything that learns, and it learns nothing itself. It
 * writes lines. That is the whole job.
 *
 * FORMAT: newline-delimited JSON at docs/ledger.ndjson. One record per line,
 * appended, never rewritten. NDJSON rather than a JSON array for three reasons:
 * an append is a single write with no parse-modify-serialise cycle that could
 * lose the file on a crash; a git diff shows added lines rather than a rewritten
 * blob; and a corrupt line costs one record instead of the whole history.
 *
 * PRIVACY: item metadata, sources and costs only. No personal context, no
 * profile fields, nothing from the application-mode research. docs/ is served
 * publicly by Pages, and this file is in it.
 */

import { appendFile, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const LEDGER = new URL('../docs/ledger.ndjson', import.meta.url);

/**
 * Per-million-token rates, USD.
 *
 * MEASURED for the Anthropic models (published rates, September 2026).
 *
 * deepseek-flash: the key used to be 'deepseek-chat' with null rates, which is
 * why every run in the ledger so far reports UNKNOWN and dailySpend() returns
 * null for every day. lib.mjs sends DEEPSEEK_MODEL = 'deepseek-flash', so the
 * lookup simply missed - the same class of mismatch run.mjs's comment says was
 * already fixed, except the fix moved the model id into a constant and left the
 * price table pointing at the old name. The one-dollar-a-day ceiling has had no
 * instrument behind it.
 *
 * THE RATES ARE SECOND-HAND. Taken from two independent pricing trackers, both
 * rechecked within the last week, both citing DeepSeek's own Models & Pricing
 * page and agreeing exactly: effective 04:00 UTC on 10 September 2026,
 * deepseek-flash serves V4.1-Flash at 0.003 cache-hit / 0.15 cache-miss input /
 * 0.60 output off-peak, exactly double at peak. NOT confirmed against DeepSeek's
 * own page. Confirm before trusting a total to two decimal places; the shape of
 * the arithmetic is right either way.
 *
 * deepseek-chat is kept deliberately null. It is a deprecated id, and if
 * anything ever sends it the cost should read UNKNOWN rather than be silently
 * priced as though it were Flash.
 */
export const PRICES = {
  'claude-opus-5':    { in: 5.00,  out: 25.00 },
  'claude-sonnet-5':  { in: 2.00,  out: 10.00 },
  'claude-haiku-4-5': { in: 1.00,  out: 5.00 },
  'deepseek-flash': {
    offPeak: { in: 0.15, out: 0.60, cacheIn: 0.003 },
    peak:    { in: 0.30, out: 1.20, cacheIn: 0.006 }
  },
  'deepseek-chat':    { in: null,  out: null },
  _webSearchPerCall: 0.01,
  _cacheReadMultiplier: 0.10
};

/**
 * Whether a moment falls inside DeepSeek's peak window.
 *
 * Peak is 01:00-04:00 and 06:00-10:00 UTC, Monday to Friday. Everything else,
 * including the whole weekend, is off-peak at half the rate.
 *
 * THIS MATTERS MORE THAN IT LOOKS. brief.yml fires at 02:00 Europe/Stockholm.
 * Through the summer that is 00:00 UTC - off-peak, and the cheapest hour there
 * is. At the end of October the clocks go back, 02:00 local becomes 01:00 UTC,
 * and the brief starts landing squarely inside the peak window on weeknights.
 * The DeepSeek half of the bill doubles on that date and nothing in the app
 * would otherwise say why. A run delayed past 01:00 UTC by the Actions
 * scheduler crosses the same line in summer.
 */
export function isPeak(at = new Date()) {
  const d = at instanceof Date ? at : new Date(at);
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return false;
  const h = d.getUTCHours();
  return (h >= 1 && h < 4) || (h >= 6 && h < 10);
}

/**
 * Resolves a model to the rate that applied at `at`.
 *
 * Two table shapes on purpose: a flat { in, out } for models billed at one
 * rate, and { peak, offPeak } for models that are not. Flattening DeepSeek to a
 * single averaged number would report a plausible figure that is wrong twice a
 * day and never says so.
 */
function rateFor(model, at) {
  const p = PRICES[model];
  if (!p) return null;
  if (p.peak && p.offPeak) return isPeak(at) ? p.peak : p.offPeak;
  if (p.in === null || p.out === null) return null;
  return { in: p.in, out: p.out, cacheIn: p.in * PRICES._cacheReadMultiplier };
}

/**
 * Cost of one model call, in USD.
 *
 * Returns null rather than zero when the rate is unknown. Zero would sum
 * silently into a daily total that looks like it is under budget.
 */
export function costOf({ model, inputTokens = 0, outputTokens = 0, cachedInputTokens = 0, searches = 0, at = null }) {
  const r = rateFor(model, at ?? new Date());
  if (!r) return null;

  const fresh = Math.max(0, inputTokens - cachedInputTokens);
  return (
    (fresh / 1e6) * r.in +
    (cachedInputTokens / 1e6) * r.cacheIn +
    (outputTokens / 1e6) * r.out +
    searches * PRICES._webSearchPerCall
  );
}

function sumCosts(calls = []) {
  const costs = calls.map((c) => c.costUsd ?? costOf(c));
  if (costs.some((c) => c === null)) return null; // one unknown makes the total unknown
  return costs.reduce((a, b) => a + b, 0);
}

async function append(record) {
  await appendFile(LEDGER, JSON.stringify(record) + '\n', 'utf8');
}

/**
 * Opens a run. Returns the id every record from this run carries, so that a
 * day's rows can be pulled back together even though they were appended
 * separately and interleaved.
 */
export function startRun(date) {
  const runId = `${date}-${randomUUID().slice(0, 8)}`;
  return {
    runId,
    date,
    startedAt: new Date().toISOString(),
    calls: []
  };
}

/**
 * Records one model call. Call this from wherever a model is invoked, with the
 * usage block the API already returns - do not estimate token counts.
 *
 * `role` is what the call was FOR (clustering, dive-research, script), not which
 * model ran it. That is what makes the routing question answerable later: which
 * roles are worth which model.
 */
export function recordCall(run, { role, model, usage = {}, searches = 0 }) {
  const call = {
    role,
    model,
    // Stamped because the rate depends on when the call was made - see isPeak.
    // Without this, re-pricing a stored call from recordItem() would use the
    // rate in force at the moment of the re-price rather than of the call.
    at: new Date().toISOString(),
    inputTokens: usage.input_tokens ?? usage.prompt_tokens ?? 0,
    outputTokens: usage.output_tokens ?? usage.completion_tokens ?? 0,
    cachedInputTokens: usage.cache_read_input_tokens ?? 0,
    searches
  };
  call.costUsd = costOf(call);
  run.calls.push(call);
  return call;
}

/** Spend so far this run. null if any call used a model with no known rate. */
export function spentSoFar(run) {
  return sumCosts(run.calls);
}

/**
 * Records a published item.
 *
 * `patterns` and `mode` are the fields that make the deep-dive loop possible.
 * An item that does not say which curiosity pattern it executed cannot later be
 * matched against whether he liked it, so the dive runner must always set them.
 */
export async function recordItem(run, item) {
  await append({
    type: 'item',
    runId: run.runId,
    date: run.date,
    at: new Date().toISOString(),

    id: item.id,
    sphere: item.sphere,
    tier: item.tier,                     // 'feed' | 'pod' | 'analys'
    kind: item.kind ?? 'news',           // 'news' | 'dive' | 'analys'

    mode: item.mode ?? null,             // 'application' | 'expansion' - dives only
    patterns: item.patterns ?? [],       // which curiosityPatterns were executed
    question: item.question ?? null,     // the question the dive set out to answer

    score: item.score ?? null,
    thin: item.thin ?? false,
    audio: Boolean(item.audio),

    sources: (item.sources ?? []).map((s) => ({
      url: s.link ?? s.url ?? null,
      outlet: s.source ?? s.outlet ?? null,
      provenance: s.provenance ?? null   // verified | reported | circulating | bakgrund | tolkning
    })),

    calls: item.calls ?? [],
    costUsd: sumCosts(item.calls ?? [])
  });
}

/**
 * Records a dive that was abandoned.
 *
 * These matter more than the successes. A run of abandonments in one sphere
 * says the topic selection is wrong, not that the researcher is weak - and
 * without a row here that pattern is invisible, because an abandoned dive
 * produces no item to notice the absence of.
 */
export async function recordAbandoned(run, { sphere, question, mode, reason, calls = [] }) {
  await append({
    type: 'abandoned',
    runId: run.runId,
    date: run.date,
    at: new Date().toISOString(),
    sphere,
    question,
    mode,
    reason,
    calls,
    costUsd: sumCosts(calls)
  });
}

/** Closes the run with the totals. Always call this, including after a failure. */
export async function finishRun(run, { feedsAnswered, feedsTried, itemsSwept, clusters, researchQueries = null, error = null } = {}) {
  const costUsd = sumCosts(run.calls);
  await append({
    type: 'run',
    runId: run.runId,
    date: run.date,
    startedAt: run.startedAt,
    finishedAt: new Date().toISOString(),
    feedsAnswered,
    feedsTried,
    itemsSwept,
    clusters,
    calls: run.calls.length,
    searches: run.calls.reduce((n, c) => n + (c.searches ?? 0), 0),
    // Queries to the external search provider. NOT part of costUsd: those are
    // billed by the search provider, not per token, and inventing a rate for
    // them here would put a made-up number inside a real total. Recorded so the
    // volume is auditable against whatever the provider's dashboard says.
    researchQueries,
    costUsd,
    error
  });

  const peakCalls = run.calls.filter((c) => isPeak(c.at)).length;
  console.log(
    `Ledger: ${run.calls.length} call(s)` +
    (peakCalls ? `, ${peakCalls} at DeepSeek peak rates` : '') +
    `, cost ${costUsd === null ? 'UNKNOWN (a model has no rate in PRICES)' : '$' + costUsd.toFixed(4)}`
  );
  return costUsd;
}

/**
 * Reads the ledger back. `since` is an ISO date string.
 *
 * Skips unparseable lines rather than throwing: a truncated final line from an
 * interrupted run should cost one record, not the ability to read the history.
 */
export async function readLedger({ since = null, type = null } = {}) {
  let raw;
  try {
    raw = await readFile(LEDGER, 'utf8');
  } catch {
    return [];
  }

  const out = [];
  let skipped = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (type && r.type !== type) continue;
      if (since && r.date < since) continue;
      out.push(r);
    } catch { skipped++; }
  }
  if (skipped) console.log(`Ledger: skipped ${skipped} unparseable line(s)`);
  return out;
}

/**
 * What the brief has spent per day, most recent first. This is the number to
 * watch against the one-dollar ceiling - not a single run's cost, because a
 * retried workflow spends twice on the same day.
 */
export async function dailySpend(days = 14) {
  const runs = await readLedger({ type: 'run' });
  const byDate = new Map();
  for (const r of runs) {
    if (r.costUsd === null) { byDate.set(r.date, null); continue; }
    if (byDate.get(r.date) === null) continue;
    byDate.set(r.date, (byDate.get(r.date) ?? 0) + r.costUsd);
  }
  return [...byDate.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .slice(0, days)
    .map(([date, costUsd]) => ({ date, costUsd }));
}
