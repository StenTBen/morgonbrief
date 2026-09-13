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
 * Per-million-token rates, input/output.
 *
 * MEASURED for the Anthropic models (published rates, September 2026).
 * PLACEHOLDER for DeepSeek: the current rate was not verified when this was
 * written, and a made-up number here would quietly corrupt every cost figure in
 * the ledger. Fill it in and the arithmetic below starts working for DeepSeek
 * too; leave it and DeepSeek rows report null cost, which is honest.
 */
export const PRICES = {
  'claude-opus-5':    { in: 5.00,  out: 25.00 },
  'claude-sonnet-5':  { in: 2.00,  out: 10.00 },
  'claude-haiku-4-5': { in: 1.00,  out: 5.00 },
  'deepseek-chat':    { in: null,  out: null },
  _webSearchPerCall: 0.01,
  _cacheReadMultiplier: 0.10
};

/**
 * Cost of one model call, in USD.
 *
 * Returns null rather than zero when the rate is unknown. Zero would sum
 * silently into a daily total that looks like it is under budget.
 */
export function costOf({ model, inputTokens = 0, outputTokens = 0, cachedInputTokens = 0, searches = 0 }) {
  const p = PRICES[model];
  if (!p || p.in === null || p.out === null) return null;

  const fresh = Math.max(0, inputTokens - cachedInputTokens);
  return (
    (fresh / 1e6) * p.in +
    (cachedInputTokens / 1e6) * p.in * PRICES._cacheReadMultiplier +
    (outputTokens / 1e6) * p.out +
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
export async function finishRun(run, { feedsAnswered, feedsTried, itemsSwept, clusters, error = null } = {}) {
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
    costUsd,
    error
  });

  console.log(`Ledger: ${run.calls.length} call(s), cost ${costUsd === null ? 'UNKNOWN (a model has no rate in PRICES)' : '$' + costUsd.toFixed(4)}`);
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
