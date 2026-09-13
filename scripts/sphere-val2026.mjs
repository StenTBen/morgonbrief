/**
 * val2026 - the election pulse. Own entry point (`npm run pulse`), not a
 * POD_RUNNERS entry.
 *
 * Why separate from run.mjs: it has no sphere flag, and it exits non-zero when
 * nothing is produced. That is right for a daily brief and wrong here. A
 * 30-minute cadence must also never be able to wedge the daily brief.
 *
 * How this sphere differs from the other three. Congress takes a document the
 * coverage pointed at and asks arithmetically whether the coverage was loud
 * enough. World subtracts Swedish coverage from international coverage. Neither
 * works on election night, when everything is covered and volume stops
 * discriminating.
 *
 * So the candidate here is a PATTERN measured across runs, and the 30-minute
 * cadence exists to build the time series that makes that measurable.
 * Frequency is the instrument. The model still only ever reports - entities,
 * claim type, and a link only where a source states one. The arithmetic below
 * decides, exactly as score() does everywhere else.
 *
 * One deliberate departure from the other spheres: the gates RANK rather than
 * admit. Karl wants 1-2 entries an hour, and a hard threshold would simply
 * produce nothing on a slow hour. So every candidate gets the strongest label
 * its counts earn, the best is published, and the label travels with the entry.
 * A thin hour reads as thin instead of being dressed up - which is the honest
 * half of what a hard gate was protecting.
 *
 * Output merges into docs/feed.json, which the app already renders generically
 * by item.sphere. A separate feed file would have had no reader.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { req, makeDeepseek, sweepMedia, fetchArticleText, fetchArticleImage, scriptSystemPrompt } from './lib.mjs';
import { speakable } from './speakable.mjs';
import { synthesizeGemini } from './synthesize-gemini.mjs';

const SPHERE_URL = new URL('../spheres/val2026.json', import.meta.url);
const CONFIG_URL = new URL('../config.json', import.meta.url);
const LEDGER_URL = new URL('../docs/val-ledger.json', import.meta.url);
const FEED_URL = new URL('../docs/feed.json', import.meta.url);
const OUT_DIR = new URL('../out/', import.meta.url);
const REPO = process.env.GITHUB_REPOSITORY || 'unknown/morgonbrief';
const AUDIO_TAG = 'audio';

// Defaults only - the sphere file overrides every one of these.
const D = {
  maxCoverageItems: 300,
  articlesPerStory: 5,
  articleMaxChars: 12000,
  articleBodyCharsInPrompt: 9000,
  tokensObservation: 32000,
  tokensEntry: 16000
};

const EMPTY_LEDGER = { lastSuccessfulRun: null, observations: [], published: [], discarded: [] };

const sha = (s) => createHash('sha1').update(String(s)).digest('hex').slice(0, 16);

async function readJson(url, fallback) {
  try { return JSON.parse(await readFile(url, 'utf8')); } catch { return fallback; }
}

// ------------------------------------------------------------------- ledger

// sweepMedia items are { source, title, summary, publishedAt, link } and carry
// no id, so the hash is built from link where there is one.
const itemHash = (it) => sha(it.link || `${it.source}::${it.title}`);
const linkKey = (o) =>
  o?.assertedLink ? `${o.assertedLink.from}->${o.assertedLink.to}:${o.assertedLink.direction}` : null;

/**
 * Idempotent by design. A delayed run overlapping its predecessor's window must
 * not double-count circulation - that would manufacture a pattern out of
 * scheduler jitter rather than out of what the press did. This dedupe is what
 * makes a generous sweep window safe.
 */
export function appendObservations(ledger, observations) {
  const seen = new Set(ledger.observations.map((o) => o.hash));
  let added = 0;
  for (const obs of observations) {
    if (seen.has(obs.hash)) continue;
    ledger.observations.push(obs);
    seen.add(obs.hash);
    added += 1;
  }
  return added;
}

export function pruneLedger(ledger, windowHours, nowMs) {
  const before = ledger.observations.length;
  const cutoff = nowMs - windowHours * 3600 * 1000;
  ledger.observations = ledger.observations.filter((o) => Date.parse(o.observedAt) >= cutoff);
  return before - ledger.observations.length;
}

// ----------------------------------------------------------------- patterns

/** levels are ordered strongest first; the first whose counts all clear wins. */
export function strengthOf(counts, levels) {
  for (const lvl of levels) {
    if (counts.clusters >= lvl.clusters && counts.runs >= lvl.runs && counts.sources >= lvl.sources) {
      return lvl.label;
    }
  }
  return null;
}

/**
 * A link becomes a candidate once it has been asserted independently across
 * enough clusters, runs and outlets to stop being one newsroom's angle. Nothing
 * here is a judgement: the counts decide, and the label records what they were.
 */
export function detectPatterns(ledger, gates) {
  const buckets = new Map();
  for (const obs of ledger.observations) {
    const key = linkKey(obs);
    if (!key) continue;
    if (!buckets.has(key)) {
      buckets.set(key, { key, clusters: new Set(), runs: new Set(), sources: new Set(), obs: [] });
    }
    const b = buckets.get(key);
    b.clusters.add(obs.clusterId);
    b.runs.add(obs.runId);
    b.sources.add(obs.source);
    b.obs.push(obs);
  }

  const out = [];
  for (const b of buckets.values()) {
    const counts = { clusters: b.clusters.size, runs: b.runs.size, sources: b.sources.size };
    const strength = strengthOf(counts, gates.levels);
    if (!strength) continue;
    out.push({
      kind: 'link',
      key: b.key,
      strength,
      counts,
      sourceCount: counts.sources,
      reasons: [`${counts.clusters} kluster`, `${counts.runs} körningar`, `${counts.sources} källor`],
      observations: b.obs
    });
  }
  return out;
}

/** A claim that circulated unconfirmed and was then picked up. The crossing is the story. */
export function detectTransitions(ledger, rules) {
  const byThread = new Map();
  for (const obs of ledger.observations) {
    if (!obs.continuesThread) continue;
    if (!byThread.has(obs.continuesThread)) byThread.set(obs.continuesThread, []);
    byThread.get(obs.continuesThread).push(obs);
  }

  const out = [];
  for (const [threadId, obs] of byThread) {
    const circulating = obs.filter((o) => o.claimType === 'circulating');
    if (!circulating.length) continue;
    const earliest = Math.min(...circulating.map((o) => Date.parse(o.observedAt)));
    const picked = obs.filter((o) => o.claimType === 'reported' && Date.parse(o.observedAt) > earliest);
    const sources = new Set(picked.map((o) => o.source));
    if (sources.size < rules.transitionMinOutlets) continue;
    out.push({
      kind: 'transition',
      key: `transition:${sha(threadId)}`,
      strength: sources.size >= 4 ? 'stark' : 'medel',
      counts: {
        clusters: new Set(obs.map((o) => o.clusterId)).size,
        runs: new Set(obs.map((o) => o.runId)).size,
        sources: sources.size
      },
      sourceCount: sources.size,
      reasons: [`cirkulerade obekräftat, plockades sedan upp av ${sources.size} redaktioner`],
      observations: [...circulating, ...picked]
    });
  }
  return out;
}

const RANK = { stark: 3, medel: 2, tunn: 1 };

// --------------------------------------------------------------- clustering

// feed.mjs owns clustering for the daily feed, but buildFeed() is a whole-feed
// operation that also writes entries, so it is the wrong tool here. This is
// deliberately crude lexical grouping: it only has to put several outlets
// covering one event into one bucket. If clusters is close to items, the counts
// inflate and the log says so.
const STOP = new Set([
  'och', 'att', 'det', 'som', 'för', 'med', 'har', 'den', 'till', 'inte', 'var', 'kan', 'ett',
  'säger', 'efter', 'från', 'sig', 'under', 'mot', 'över', 'vid', 'blir', 'hade', 'ska',
  'the', 'and', 'for', 'that', 'with', 'says', 'after', 'from'
]);

function tokens(it) {
  return new Set(
    `${it.title} ${it.summary ?? ''}`
      .toLowerCase()
      .replace(/[^\p{L}\s]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 3 && !STOP.has(w))
  );
}

export function clusterItems(items, threshold = 0.34) {
  const clusters = [];
  for (const item of items) {
    const t = tokens(item);
    if (t.size < 4) continue;
    const hit = clusters.find((c) => {
      let n = 0;
      for (const tok of t) if (c.tokens.has(tok)) n += 1;
      return n / Math.min(t.size, c.tokens.size, 25) >= threshold;
    });
    if (hit) {
      hit.items.push(item);
      for (const tok of t) hit.tokens.add(tok);
    } else {
      clusters.push({ id: itemHash(item), tokens: t, items: [item] });
    }
  }
  return clusters.map((c) => ({ ...c, sourceCount: new Set(c.items.map((i) => i.source)).size }));
}

// -------------------------------------------------------------- model calls

const OBSERVATION_SYSTEM =
  'You report observations about news coverage of a Swedish election. You never rank, score, or decide ' +
  'what matters.\n' +
  'For each source in each cluster, report:\n' +
  '  claimType   "verified" when the text cites a primary document, "reported" when a named outlet ' +
  'asserts it under its own byline, "circulating" when it is an unconfirmed claim in circulation.\n' +
  '  entities    actors, parties, institutions, constituencies actually named.\n' +
  '  assertedLink  ONLY if the text itself states a cause-effect or benefit relation. Never infer a link ' +
  'the text does not make. Null when there is none.\n' +
  '  linkSource  which outlet stated the link. Required whenever assertedLink is set.\n' +
  '  continuesThread  an id from the known threads, or a new short slug.\n' +
  '  facts       discrete factual assertions present in the text.\n' +
  'Omission means "nothing new here", never "this thread is over". Report only on what you are given; ' +
  'never recall a fact from memory. Return strict JSON only.';

/**
 * Observations are batched rather than sent one call per cluster.
 *
 * 99 clusters in a single call would overrun the output ceiling - the trap
 * already recorded in STATUS, where asking the model to report on everything
 * rather than only the gaps overflowed the cap. Batching keeps each response
 * inside its budget, and a truncated batch costs one batch rather than the
 * whole pulse.
 */
async function observeBatch(clusters, knownThreads, { deepseek, L }) {
  const material = clusters.map((c, i) => ({
    clusterIndex: i,
    sources: c.items.slice(0, L.articlesPerStory).map((it) => ({
      source: it.source,
      title: it.title,
      summary: (it.summary ?? '').slice(0, 400)
    }))
  }));

  try {
    const out = await deepseek(
      [
        { role: 'system', content: OBSERVATION_SYSTEM },
        {
          role: 'user',
          content:
            `Known threads so far: ${JSON.stringify(knownThreads)}\n\n` +
            `Clusters:\n${JSON.stringify(material, null, 1)}\n\n` +
            'Return {"observations":[{"clusterIndex":0,"source":"...",' +
            '"claimType":"verified|reported|circulating","entities":["..."],' +
            '"assertedLink":{"from":"...","to":"...","direction":"gynnar|skadar|orsakar"},' +
            '"linkSource":"...","continuesThread":"...","facts":["..."]}]}\n' +
            'assertedLink must be null when the text asserts no relation. One entry per source.'
        }
      ],
      { json: true, maxTokens: L.tokensObservation }
    );
    return Array.isArray(out.observations) ? out.observations : [];
  } catch (e) {
    // makeDeepseek throws on finish_reason === 'length' with the cap named, so
    // surface it as truncation rather than letting it read as a format bug.
    console.log(`  observation batch failed - ${e.message}`);
    return [];
  }
}

/**
 * Research and writing in one call.
 *
 * The full article text IS the primary-source layer here. Valmyndigheten's
 * machine-readable endpoint is unverified, and building against an unverified
 * endpoint the day before an election would fail in a way that reads exactly
 * like a quiet news day. The ledger recorded what the teasers said; the full
 * text is what the reader has not seen. The model reports which facts appeared
 * only in the full text - it reports, it does not score.
 */
async function researchAndWrite(candidate, sphere, config, { deepseek, L }) {
  const sources = [...new Map(
    candidate.observations.flatMap((o) => o.sources ?? []).map((s) => [s.link, s])
  ).values()].slice(0, L.articlesPerStory);

  const bodies = await Promise.all(
    sources.map((s) => fetchArticleText(s.link, { maxChars: L.articleMaxChars }))
  );
  const fetched = bodies.filter(Boolean).length;
  console.log(`  fetched full text for ${fetched}/${sources.length} source(s)`);

  // Only the lead source's picture is worth fetching: the app shows one image,
  // on the top entry, and only when it is a real photograph from the story.
  const image = sources[0] ? await fetchArticleImage(sources[0].link) : null;
  if (image) console.log('  lead image: ' + image.slice(0, 70));

  const alreadyKnown = [...new Set(candidate.observations.flatMap((o) => o.facts ?? []))];

  const out = await deepseek(
    [
      { role: 'system', content: scriptSystemPrompt(sphere, config) },
      {
        role: 'user',
        content:
          `Mönstret: ${candidate.key}\n` +
          `Styrka: ${candidate.strength} (${candidate.reasons.join(', ')})\n\n` +
          'Vad bevakningen redan sagt (detta har läsaren sannolikt redan sett):\n' +
          `${JSON.stringify(alreadyKnown, null, 1)}\n\n` +
          `Fulltext:\n${JSON.stringify(
            sources.map((s, i) => ({
              source: s.source,
              title: s.title,
              body: bodies[i] ? bodies[i].slice(0, L.articleBodyCharsInPrompt) : null
            })),
            null,
            1
          )}\n\n` +
          'Skriv texten. Returnera {"kategori":"ETT SVENSKT ORD I VERSALER","rubrik":"...",' +
          '"sammanfattning":"texten, flera stycken","synthes":"en mening om vad fulltexten tillförde ' +
          'utöver bevakningen","nyaFakta":["fakta som fanns i fulltexten men inte i listan ovan"]}\n' +
          'nyaFakta är en rapport, inte en bedömning: lista det som faktiskt saknades. En tom lista är ' +
          'ett giltigt svar och ska då sägas rakt ut i texten.'
      }
    ],
    { json: true, maxTokens: L.tokensEntry }
  );

  const prose = `${out.rubrik ?? ''} ${out.sammanfattning ?? ''} ${out.synthes ?? ''}`;
  const words = prose.trim().split(/\s+/).filter(Boolean).length;
  const novel = Array.isArray(out.nyaFakta) ? out.nyaFakta : [];

  return {
    id: `feed-val2026-${sha(candidate.key)}`,
    sphere: 'val2026',
    // The strength label is folded into kategori because that is the field the
    // app actually renders in the meta line. It was the whole compensation for
    // gates that rank instead of admit - a label nothing displays protects
    // nobody. Both `sphere` and `kategori` are set so the entry renders under
    // either version of index.html.
    kategori: `${(out.kategori || 'VAL').toUpperCase()} · ${candidate.strength.toUpperCase()}`.slice(0, 24),
    rubrik: out.rubrik ?? candidate.key,
    sammanfattning: out.sammanfattning ?? '',
    synthes: out.synthes ?? '',
    // The strength label travels with the entry so a thin hour reads as thin.
    styrka: candidate.strength,
    underlag: candidate.reasons.join(', '),
    nyaFakta: novel.length,
    image,
    leadSource: sources[0]?.source ?? '',
    publishedAt: new Date().toISOString(),
    readMinutes: Math.max(1, Math.round(words / 180)),
    sourceCount: candidate.sourceCount,
    singleSource: candidate.sourceCount < 2,
    enriched: fetched > 0,
    sources: sources.slice(0, 6)
  };
}

// ------------------------------------------------------------------- audio

/**
 * One MP3 per published entry, not one a day.
 *
 * The pulse publishes through the day, and the point is to be able to listen
 * while it grows. Separate files rather than a growing concatenation: rebuilding
 * one file would mean re-downloading every earlier segment on every pulse, and
 * by evening that is fifty files every thirty minutes. The app's player already
 * auto-advances on ended, so pressing play on the newest and letting it run
 * walks the day backwards on its own.
 *
 * Returns null rather than throwing. Audio is the nice-to-have here; the text
 * entry is the deliverable, and a TTS failure must not cost the entry.
 */
async function synthesizeEntry(entry, config, sa) {
  if (!sa) {
    console.log('  audio: no service account, text only');
    return null;
  }

  const script = [entry.rubrik, entry.sammanfattning, entry.synthes].filter(Boolean).join('\n\n');
  const lexicon = {
    ...(config.speech?.pronunciationLexicon?.shared ?? {}),
    ...(config.speech?.pronunciationLexicon?.perSphere?.val2026 ?? {})
  };

  const unresolved = [];
  const { markup } = speakable(script, { lexicon, onUnresolved: (t) => unresolved.push(...t) });
  if (unresolved.length) console.log(`  audio: ${unresolved.length} unresolved term(s): ${unresolved.join(', ')}`);

  try {
    const { audio, usedFallback, refusals } = await synthesizeGemini(markup, sa, config.tts);
    if (usedFallback) console.log('  audio: NOTE fell back to Chirp, no style control applied');
    if (refusals.length) console.log(`  audio: NOTE ${refusals.length} chunk(s) refused by the safety filter, not silence`);

    await mkdir(OUT_DIR, { recursive: true });
    const file = `pod-val2026-${entry.id.replace(/^feed-val2026-/, '')}.mp3`;
    await writeFile(new URL(file, OUT_DIR), audio);
    console.log(`  audio: ${file}, ${(audio.length / 1e6).toFixed(2)} MB`);

    return {
      file,
      audioUrl: `https://github.com/${REPO}/releases/download/${AUDIO_TAG}/${file}`,
      audioBytes: audio.length
    };
  } catch (e) {
    console.log(`  audio: failed - ${e.message}`);
    return null;
  }
}

// -------------------------------------------------------------------- main

async function main() {
  const sphere = JSON.parse(await readFile(SPHERE_URL, 'utf8'));
  const config = await readJson(CONFIG_URL, {});
  const L = { ...D, ...(config.limits ?? {}), ...(sphere.limits ?? {}) };
  const deepseek = makeDeepseek(req('DEEPSEEK_API_KEY'));

  // Optional on purpose: a missing key means text-only pulses rather than a
  // failed run.
  let serviceAccount = null;
  try {
    serviceAccount = JSON.parse(process.env.GCP_SERVICE_ACCOUNT ?? 'null');
  } catch {
    console.log('GCP_SERVICE_ACCOUNT is not valid JSON - continuing without audio.');
  }

  const now = new Date();
  const nowIso = now.toISOString();

  // DRY RUN: sweep and report, no model calls and no writes. This exists
  // because the only check that matters before election day is which of the
  // feed URLs are actually alive, and the window guard below would otherwise
  // exit before the sweep ever runs.
  const dryRun = process.env.PULSE_DRY_RUN === '1';
  const force = process.env.PULSE_FORCE === '1' || dryRun;

  // The runner owns the window, not the cron. A stray firing outside it costs
  // one no-op job rather than an unwanted run.
  const outside = now < new Date(sphere.pulse.from) || now > new Date(sphere.pulse.until);
  if (outside && !force) {
    console.log(`Outside the pulse window (${sphere.pulse.from} to ${sphere.pulse.until}) - nothing to do.`);
    return;
  }
  if (outside) console.log('Outside the pulse window, but forced - proceeding.');
  if (dryRun) console.log('DRY RUN: sweeping only. No model calls, no writes.');

  const ledger = await readJson(LEDGER_URL, structuredClone(EMPTY_LEDGER));
  console.log(`val2026 pulse ${nowIso} (last success: ${ledger.lastSuccessfulRun ?? 'never'})`);

  const items = (await sweepMedia(sphere.feeds, {
    windowHours: sphere.pulse.sweepWindowHours,
    label: '  val2026 sweep'
  })).slice(0, L.maxCoverageItems);

  const clusters = clusterItems(items)
    .sort((a, b) => b.sourceCount - a.sourceCount)
    .slice(0, sphere.maxObservedClusters);

  console.log(`  ${items.length} items -> ${clusters.length} clusters observed (cap ${sphere.maxObservedClusters})`);
  if (items.length && clusters.length > items.length * 0.8) {
    console.log('  WARNING: clustering is not grouping - pattern counts will inflate');
  }

  if (dryRun) {
    // Which outlets actually produced items is the real answer here: a feed can
    // return 200 OK and still be the wrong URL. Compare this list against the
    // sphere file and delete what never appears.
    const bySource = new Map();
    for (const it of items) bySource.set(it.source, (bySource.get(it.source) ?? 0) + 1);
    console.log(`\n  Live sources (${bySource.size}):`);
    for (const [src, n] of [...bySource].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(n).padStart(3)}  ${src}`);
    }
    console.log('\n  Largest clusters:');
    for (const c of clusters.slice(0, 10)) {
      console.log(`    ${c.sourceCount} sources :: ${c.items[0].title.slice(0, 80)}`);
    }
    console.log('\nDRY RUN complete. Nothing written, no model calls made.');
    return;
  }

  // ---- observations, batched ----------------------------------------------
  const knownThreads = [...new Set(ledger.observations.map((o) => o.continuesThread).filter(Boolean))].slice(0, 80);
  const batchSize = sphere.observationBatchSize ?? 25;
  const observations = [];

  for (let i = 0; i < clusters.length; i += batchSize) {
    const batch = clusters.slice(i, i + batchSize);
    const reported = await observeBatch(batch, knownThreads, { deepseek, L });
    for (const o of reported) {
      const cluster = batch[o.clusterIndex];
      if (!cluster) continue;
      observations.push({
        ...o,
        sources: cluster.items.map((it) => ({ source: it.source, title: it.title, link: it.link })),
        clusterId: cluster.id,
        runId: nowIso,
        observedAt: nowIso,
        hash: sha(`${cluster.id}|${o.source}|${linkKey(o) ?? o.claimType}`)
      });
    }
    console.log(`  batch ${Math.floor(i / batchSize) + 1}: ${reported.length} observation(s)`);
  }

  const added = appendObservations(ledger, observations);
  const pruned = pruneLedger(ledger, sphere.patternGates.ledgerWindowHours, now.getTime());
  console.log(`  ledger +${added}, -${pruned} aged out, ${ledger.observations.length} in window`);

  // ---- arithmetic ---------------------------------------------------------
  const publishedKeys = new Set(ledger.published.map((p) => p.key));
  let candidates = [
    ...detectPatterns(ledger, sphere.patternGates),
    ...detectTransitions(ledger, sphere.rumourRules)
  ]
    .filter((c) => !publishedKeys.has(c.key))
    .sort((a, b) => RANK[b.strength] - RANK[a.strength] || b.sourceCount - a.sourceCount);

  // 1-2 an hour was the requirement, so a pulse that finds no qualifying link
  // still publishes: the largest unpublished cluster becomes a thin candidate.
  // It is labelled "tunn", and the script rules require the text to say so
  // rather than write around it.
  if (!candidates.length) {
    const fallback = clusters
      .map((c) => ({ ...c, key: `cluster:${c.id}` }))
      .filter((c) => !publishedKeys.has(c.key) && c.sourceCount >= 2)
      .sort((a, b) => b.sourceCount - a.sourceCount)[0];

    if (fallback) {
      console.log('  no qualifying link this pulse - falling back to the largest unpublished cluster');
      candidates = [{
        kind: 'cluster',
        key: fallback.key,
        strength: 'tunn',
        counts: { clusters: 1, runs: 1, sources: fallback.sourceCount },
        sourceCount: fallback.sourceCount,
        reasons: [`ett kluster, en körning, ${fallback.sourceCount} källor`],
        observations: [{
          source: fallback.items[0].source,
          claimType: 'reported',
          facts: [],
          sources: fallback.items.map((it) => ({ source: it.source, title: it.title, link: it.link }))
        }]
      }];
    }
  }

  const chosen = candidates.slice(0, sphere.publishPerPulse);
  console.log(`  ${candidates.length} candidate(s), publishing ${chosen.length}`);
  for (const c of chosen) console.log(`    ${c.strength.padEnd(6)} ${c.key} :: ${c.reasons.join(', ')}`);

  // ---- research and write -------------------------------------------------
  const entries = [];
  for (const candidate of chosen) {
    try {
      const built = await researchAndWrite(candidate, sphere, config, { deepseek, L });

      if (config.audio?.val2026?.enabled) {
        const audio = await synthesizeEntry(built, config, serviceAccount);
        if (audio) Object.assign(built, audio);
      }

      entries.push(built);
      // The whole entry is stored, not just the key. The nightly run rewrites
      // docs/feed.json wholesale at 02:00, which now falls inside the pulse
      // window - so the ledger is the only place these survive that.
      ledger.published.push({ key: candidate.key, strength: candidate.strength, at: nowIso, entry: built });
    } catch (e) {
      console.log(`  ${candidate.key}: write failed - ${e.message}`);
      ledger.discarded.push({ key: candidate.key, reason: e.message, at: nowIso });
    }
  }

  // ---- merge into the feed the app already reads --------------------------
  // EVERY entry published in this window is re-merged, not just this run's.
  //
  // The nightly run at 02:00 falls inside the pulse window and rewrites
  // docs/feed.json wholesale, so anything published before it would otherwise
  // vanish. Replaying the ledger makes the next pulse restore them, which means
  // the loss lasts at most one cycle and needs no change to the nightly run.
  const feed = await readJson(FEED_URL, { date: nowIso.slice(0, 10), builtAt: nowIso, episodes: [], feed: [] });

  const allMine = ledger.published
    .map((p) => p.entry)
    .filter(Boolean)
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));

  const mineIds = new Set(allMine.map((e) => e.id));
  feed.feed = [...allMine, ...(feed.feed ?? []).filter((e) => !mineIds.has(e.id))];
  feed.builtAt = nowIso;
  console.log(`  feed: ${allMine.length} val2026 entr(ies) restored, ${feed.feed.length} total`);

  // ---- episodes: newest first, reset each day ------------------------------
  // The player builds one pill per episode that has an audioUrl, so the list is
  // capped: uncapped it would be fifty buttons by evening. Entries stay in the
  // feed regardless - the cap only limits what is playable.
  const A = config.audio?.val2026 ?? {};
  if (A.enabled) {
    const today = nowIso.slice(0, 10);
    const mineEpisodes = allMine
      .filter((e) => e.audioUrl)
      .filter((e) => !A.resetDaily || e.publishedAt.slice(0, 10) === today)
      .slice(0, A.maxEpisodes ?? 24)
      .map((e) => ({
        sphere: 'val2026',
        // kind is what keeps these out of the four fixed area slots in the app.
        // Without it a pulse episode and the nightly Valet episode are
        // indistinguishable, and a day of pulses buries the daily four.
        kind: 'pulse',
        // One pill per pulse, so the label has to distinguish them. Time plus
        // strength turns the pulse list into a readable timeline of the day.
        sphereLabel: `Valet ${new Date(e.publishedAt).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Stockholm' })} · ${e.styrka}`,
        audioUrl: e.audioUrl,
        audioBytes: e.audioBytes,
        itemCount: 1,
        // Empty on purpose: the app renders deep items from episodes, and these
        // entries are already in the feed above.
        items: []
      }));

    // Only this sphere's PULSE episodes are replaced. The earlier version
    // filtered out every val2026 episode, which silently deleted the nightly
    // Valet episode on the first pulse after 02:00.
    const others = (feed.episodes ?? []).filter((e) => !(e.sphere === 'val2026' && e.kind === 'pulse'));
    feed.episodes = [...mineEpisodes, ...others];
    console.log(`  episodes: ${mineEpisodes.length} pulse(s), ${others.length} kept (incl. the nightly Valet episode)`);
  }

  ledger.lastSuccessfulRun = nowIso;
  await writeFile(LEDGER_URL, JSON.stringify(ledger, null, 2));
  await writeFile(FEED_URL, JSON.stringify(feed, null, 2));

  console.log(`Done: ${entries.length} published, ${ledger.published.length} total this window`);
}

// Only run when executed directly. run.mjs imports clusterItems() from this
// file for the nightly val2026 episode, and without this guard that import
// would fire a whole pulse in the middle of the nightly brief.
//
// Unlike run.mjs this does not exit non-zero on an empty result: a quiet pulse
// is a correct pulse, and only a crash should surface in Actions.
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

export { main as runPulse };
