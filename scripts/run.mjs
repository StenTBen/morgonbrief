/**
 * Morgonbrief - daily orchestrator.
 *
 * Two tiers come out of one sweep, because they want opposite things:
 *
 *   FEED  - everything the sweep found inside the active spheres, clustered by
 *           story, rewritten and synthesised. No threshold. This is what Karl
 *           reads at 06:00.
 *   POD   - only what cleared the sphere's threshold, grounded in primary
 *           documents. Usually zero to two items. This is what he listens to
 *           in the car.
 *
 * Output goes to docs/feed.json, committed to the repo by the workflow so the
 * app reads it same-origin from GitHub Pages - cacheable by the service worker,
 * no CORS question, and it still works with no signal. Firestore is used only
 * for feedback writes now.
 */

import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { req, makeDeepseek, sweepMedia, fetchArticleImage, scriptSystemPrompt, clusterItems, DEEPSEEK_MODEL } from './lib.mjs';
import { speakable } from './speakable.mjs';
import { synthesizeGemini } from './synthesize-gemini.mjs';
import { buildFeed } from './feed.mjs';
import { startRun, recordCall, recordItem, finishRun } from './ledger.mjs';
import { applyFeedback } from './feedback.mjs';
import { makeResearcher } from './research.mjs';
import * as Congress from './sphere-congress.mjs';
import * as Sverige from './sphere-sverige.mjs';
import * as Crypto from './sphere-crypto.mjs';
import * as World from './sphere-world.mjs';

const DEEPSEEK_KEY = req('DEEPSEEK_API_KEY');
const CONGRESS_KEY = req('CONGRESS_API_KEY');
const SA = JSON.parse(req('GCP_SERVICE_ACCOUNT'));
const REPO = process.env.GITHUB_REPOSITORY || 'unknown/morgonbrief';
const AUDIO_TAG = 'audio';

const today = new Date().toISOString().slice(0, 10);

// The run's ledger handle, created before anything can spend. A failure three
// lines into main() still produces a row saying what it cost.
const run = startRun(today);

// Metered at the client rather than at the call sites - see makeDeepseek.
const deepseek = makeDeepseek(DEEPSEEK_KEY, {
  // DEEPSEEK_MODEL, not a literal. Hardcoding the name here meant the ledger
  // priced a model the code never calls, so every run reported UNKNOWN while
  // looking correct. The id now comes from the same constant the request uses,
  // which is the only way the two cannot drift apart.
  onUsage: (usage, role) => recordCall(run, { role, model: DEEPSEEK_MODEL, usage })
});

// Voice and delivery are taste decisions; they live in config.json so they can
// be changed and re-run without touching any code.
const config = JSON.parse(await readFile(new URL('../config.json', import.meta.url), 'utf8'));

// --------------------------------------------------------------- research

/**
 * One researcher for the whole run, built after config because it reads
 * config.research.
 *
 * Single instance on purpose: it holds the rate-limit clock, and two of them
 * would each believe they were the only caller. Returns empty arrays when
 * BRAVE_API_KEY is unset or the provider is 'none', so a missing secret costs
 * the tolkning tier in the sverige sphere and nothing else anywhere.
 */
const research = makeResearcher(config);

// --------------------------------------------------------------- pod tier

async function podCongress(sphere, coverage, seen) {
  const candidates = await Congress.linkCoverage(coverage, { deepseek, today, limits: config.limits });
  const scored = [];
  for (const c of candidates) {
    try {
      const doc = await Congress.fetchPrimarySource(c, { apiKey: CONGRESS_KEY });
      if (seen.has(doc.id)) { console.log(`  skip (already covered): ${doc.id}`); continue; }
      scored.push(Congress.score(doc, sphere));
    } catch (e) {
      console.log(`  skip (${c.billType}${c.billNumber}): ${e.message}`);
    }
  }
  const chosen = pick(scored, sphere);

  // Two paths, and the order matters. A bill on Congress.gov is a document, and
  // a document beats reporting about a document - so the fallback only runs when
  // the primary path found nothing at all. Zero linked bills for four runs is
  // what made this necessary: the sphere was not quiet, it was blind.
  if (!chosen.length && sphere.fallback?.enabled) {
    return politicalFallback(sphere);
  }

  const [cards, script] = await Promise.all([
    Congress.writeCards(chosen, { deepseek, limits: config.limits }),
    Congress.writeScript(chosen, sphere, { deepseek, today, config })
  ]);
  return { chosen, script, items: chosen.map((d) => Congress.cardFromDoc(d, cards.find((c) => c.id === d.id) ?? {})) };
}

async function podCrypto(sphere, coverage, seen) {
  const governanceIndex = await Crypto.loadGovernanceIndex(sphere);
  const candidates = await Crypto.linkCoverage(coverage, { deepseek, today, governanceIndex, sphere, limits: config.limits });
  const scored = [];
  for (const c of candidates) {
    try {
      const doc = await Crypto.fetchPrimarySource(c, { governanceIndex });
      if (seen.has(doc.id)) { console.log(`  skip (already covered): ${doc.id}`); continue; }
      scored.push(Crypto.score(doc, sphere));
    } catch (e) {
      console.log(`  skip (${c.kind} ${c.chain ?? c.forumIndex ?? ''}): ${e.message}`);
    }
  }
  const chosen = pick(scored, sphere);
  const [cards, script] = await Promise.all([
    Crypto.writeCards(chosen, { deepseek, limits: config.limits }),
    Crypto.writeScript(chosen, sphere, { deepseek, today, config })
  ]);
  return { chosen, script, items: chosen.map((d) => Crypto.cardFromDoc(d, cards.find((c) => c.id === d.id) ?? {})) };
}

/**
 * Ranks rather than admits.
 *
 * The threshold used to be a cutoff and an empty episode was a correct answer.
 * The requirement now is four episodes a day, so the cutoff would only mean a
 * silent sphere on a slow day. The score still decides the ORDER - it is the
 * same arithmetic, used to rank instead of to exclude.
 *
 * What is lost is the honest signal that a day was thin, so the old threshold
 * is kept and logged as a label. NOTE: that label is currently only in the log.
 * It does not reach the script, so the listener is not told when an item is
 * weak. Threading it into writeScript is the obvious next step and is not done.
 *
 * This also does not fix an empty list. Congress has linked zero bills for four
 * runs; ranking nothing still yields nothing. That problem is upstream in
 * linkCoverage.
 */
function pick(scored, sphere) {
  const threshold = sphere.scoring?.threshold ?? 0;
  const chosen = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, sphere.maxItemsPerEpisode)
    .map((d) => ({ ...d, thin: d.score < threshold }));

  const thin = chosen.filter((d) => d.thin).length;
  console.log(`  scored ${scored.length}, chose ${chosen.length}${thin ? `, ${thin} below the old threshold of ${threshold}` : ''}`);
  for (const d of chosen) console.log(`    ${d.score}${d.thin ? ' THIN' : '    '} ${d.id} :: ${d.reasons.join(', ')}`);
  return chosen;
}


/**
 * The world sphere works differently from the others: instead of linking
 * coverage to an external primary source, it subtracts Swedish coverage from
 * international coverage and treats what is left as the signal. Only the gap
 * stories are returned to the caller, so only gaps reach the feed - otherwise
 * this would just be a second helping of the world news Karl already read.
 */
async function podWorld(sphere, coverage, seen) {
  const swedish = await sweepMedia(sphere.swedishShadowFeeds, { label: '  swedish shadow' });
  const clusters = await World.findGaps(coverage, swedish, { deepseek, today, sphere, limits: config.limits });

  const scored = clusters.map((c) => World.score(c, sphere));
  const fresh = scored.filter((c) => !seen.has(`world-${Buffer.from(c.label).toString('base64url').slice(0, 24)}`));

  // Everything that reads as a gap goes to the feed; only the strongest are
  // read aloud. A weak gap is still worth seeing, just not worth four minutes.
  const gaps = fresh.filter((c) => c.swedishCoverage !== 'full' && c.sourceCount >= sphere.sourceThresholds.some);
  // Ranked, not admitted - see pick(). The gap filter above is untouched: it is
  // what the sphere IS, not a quality bar, and weakening it would turn the
  // world episode back into a second helping of news Karl already read.
  const wThreshold = sphere.scoring?.threshold ?? 0;
  const chosen = fresh
    .sort((a, b) => b.score - a.score)
    .slice(0, sphere.maxItemsPerEpisode)
    .map((c) => ({ ...c, thin: c.score < wThreshold }));

  console.log(`  scored ${scored.length}, gaps ${gaps.length}, chose ${chosen.length}`);
  for (const c of chosen) console.log(`    ${c.score}${c.thin ? ' THIN' : '    '} ${c.label} :: ${c.reasons.join(', ')}`);

  await World.enrich(chosen, config.limits);

  const [cards, script] = await Promise.all([
    World.writeCards(chosen, { deepseek, limits: config.limits }),
    World.writeScript(chosen, sphere, { deepseek, today, config })
  ]);

  return {
    chosen: chosen.map((c) => ({ id: `world-${Buffer.from(c.label).toString('base64url').slice(0, 24)}` })),
    script,
    items: chosen.map((c, i) => World.cardFromCluster(c, cards.find((x) => x.index === i) ?? {})),
    // Only gap items flow onward into the feed.
    feedCoverage: gaps.flatMap((c) => c.items)
  };
}

/**
 * Political coverage without a bill, including claims that are only circulating.
 *
 * Washington runs on anonymous sourcing, so a sphere that only accepts what a
 * primary document confirms will miss much of what actually moves. The first
 * three provenance tiers - verified, reported, circulating - are shared with the
 * sverige sphere and apply unchanged here: a circulating claim is described as
 * circulation, never restated as fact, and never carries an item alone. The
 * fourth tier, tolkning, is NOT shared. It requires the retrieval pass, and this
 * fallback deliberately has none. Those rules live in
 * the sphere's scriptRules, which scriptSystemPrompt renders.
 *
 * Deliberately builds no cards. These are teasers and headlines; a card built on
 * a teaser is indistinguishable from a card built on a document, and that is
 * exactly the distinction the sphere exists to keep.
 */
async function politicalFallback(sphere) {
  const f = sphere.fallback;
  console.log(`  no linked bills - falling back to political coverage (${f.windowHours}h)`);

  const items = (await sweepMedia(sphere.feeds, { windowHours: f.windowHours, label: '  politics sweep' }))
    .slice(0, config.limits?.maxCoverageItems ?? 400);

  const clusters = clusterItems(items)
    .filter((c) => c.sourceCount >= f.minSources)
    .sort((a, b) => b.sourceCount - a.sourceCount)
    .slice(0, f.maxClusters);

  if (!clusters.length) {
    console.log(`  nothing carried by ${f.minSources}+ outlets - no episode material`);
    return { chosen: [], script: '', items: [] };
  }

  for (const c of clusters) console.log(`    ${c.sourceCount} sources :: ${c.items[0].title.slice(0, 70)}`);

  const script = await deepseek(
    [
      { role: 'system', content: scriptSystemPrompt(sphere, config) },
      {
        role: 'user',
        content:
          'Inget lagförslag gick att länka idag, så avsnittet bygger på bevakning. Säg det rakt ut. ' +
          'Där en uppgift bara cirkulerar utan bekräftelse: beskriv att den cirkulerar och vem som ' +
          'rapporterar den, aldrig som ett faktum.\n\n' +
          JSON.stringify(
            clusters.map((c) => ({
              sources: c.items.slice(0, 5).map((it) => ({ source: it.source, title: it.title, summary: it.summary }))
            })),
            null,
            1
          )
      }
    ],
    { maxTokens: config.limits?.tokensScript ?? 16000 }
  );

  return { chosen: clusters.map((c) => ({ id: `congress-fb-${c.id}` })), script, items: [] };
}

/**
 * Sveriges politik.
 *
 * A thin wrapper on purpose. congress and crypto are assembled here out of
 * link-then-score-then-write pieces their modules export, because each step has
 * a different failure mode worth seeing separately. This sphere is one sequence
 * - cluster, fetch, research, write - so it lives whole in its own module and
 * run.mjs only supplies the clients.
 *
 * Note what is NOT here any more. podVal2026 ignored this `coverage` argument
 * and swept the sphere's 28 feeds a second time, so every night cost two full
 * sweeps for one episode. It also returned no feedCoverage, so run.mjs fell
 * through to the whole sweep and all of it went into buildFeed - which is why
 * the election sphere was the largest post in the pipeline. It was not finding
 * the most; it was filtering the least. Both are handled inside the module: the
 * passed coverage is used, and only the clustered items travel onward.
 */
async function podSverige(sphere, coverage, seen) {
  return Sverige.runEpisode(sphere, coverage, seen, { deepseek, config, research });
}

const POD_RUNNERS = { congress: podCongress, crypto: podCrypto, world: podWorld, sverige: podSverige };

// --------------------------------------------------------------- main

async function main() {
  // FIRST, before anything reads profile.json. The feedback loop rewrites the
  // knowledge levels, and a script prompt built before this ran would be
  // written for yesterday's level - the change would apply a day late, every
  // day, which is worse than not applying it at all because the log would say
  // it worked.
  //
  // It never throws: a missing calibration costs a day of tuning, a failed run
  // costs the episode.
  try {
    await applyFeedback({ serviceAccount: SA });
  } catch (e) {
    console.log(`Feedback: skipped (${e.message})`);
  }

  const files = (await readdir(new URL('../spheres/', import.meta.url))).filter((f) => f.endsWith('.json'));
  const spheres = (await Promise.all(
    files.map(async (f) => JSON.parse(await readFile(new URL(`../spheres/${f}`, import.meta.url), 'utf8')))
  )).filter((s) => s.status === 'active');

  console.log(`Active spheres: ${spheres.map((s) => s.id).join(', ')}`);
  await mkdir(new URL('../out/', import.meta.url), { recursive: true });

  // Load what we have already covered, so the pod never repeats itself.
  let seenState = {};
  try {
    seenState = JSON.parse(await readFile(new URL('../docs/seen.json', import.meta.url), 'utf8'));
  } catch { /* first run */ }

  // Terms the pronunciation lexicon did not know. This log is the only thing
  // that makes the speech work compound: promote what it catches into
  // config.speech.pronunciationLexicon and the same name is never mispronounced
  // twice. Without promotion the effort costs the same every night forever.
  const unresolvedSink = new Set();
  let unresolvedKnown = [];
  try {
    unresolvedKnown = JSON.parse(await readFile(new URL('../docs/unresolved-terms.json', import.meta.url), 'utf8')).terms ?? [];
  } catch { /* first run */ }

  const allCoverage = [];
  const episodes = [];

  for (const sphere of spheres) {
    console.log(`\n=== ${sphere.label} ===`);
    try {
      const coverage = (await sweepMedia(sphere.feeds, { label: '  sweep' }))
        .map((it) => ({ ...it, sphere: sphere.id }));

      const runner = POD_RUNNERS[sphere.id];
      if (!runner) {
        console.log(`  no pod runner for "${sphere.id}", feed only`);
        allCoverage.push(...coverage);
        continue;
      }

      const seen = new Set(seenState[sphere.id] ?? []);
      const { chosen, script, items, feedCoverage } = await runner(sphere, coverage, seen);

      // A sphere may hand the feed a filtered subset rather than everything it
      // swept - the world sphere does, because only the gaps are the point.
      allCoverage.push(...(feedCoverage ?? coverage));

      // Deterministic normalization before synthesis, never a second model
      // pass: a model rewriting the finished script is a new place for figures
      // and names to drift. Output is Swedish respelling, because custom
      // pronunciations are unavailable for sv-SE - there is no phoneme override
      // to reach for.
      const lexicon = {
        ...(config.speech?.pronunciationLexicon?.shared ?? {}),
        ...(config.speech?.pronunciationLexicon?.perSphere?.[sphere.id] ?? {})
      };
      const { markup, unresolved } = speakable(script, {
        lexicon,
        onUnresolved: (tokens) => { for (const t of tokens) unresolvedSink.add(t); }
      });
      if (unresolved.length) console.log(`  ${unresolved.length} unresolved term(s) logged`);

      const { audio, usedFallback, refusals } = await synthesizeGemini(markup, SA, config.tts);
      if (usedFallback) console.log('  NOTE: fell back to Chirp for at least one chunk - no style control applied');
      if (refusals.length) console.log(`  NOTE: ${refusals.length} chunk(s) refused by the safety filter, not silence`);

      const file = `pod-${sphere.id}-${today}.mp3`;
      await writeFile(new URL(`../out/${file}`, import.meta.url), audio);

      episodes.push({
        sphere: sphere.id,
        sphereLabel: sphere.label,
        audioUrl: `https://github.com/${REPO}/releases/download/${AUDIO_TAG}/${file}`,
        audioBytes: audio.length,
        itemCount: items.length,
        items,
        script
      });

      seenState[sphere.id] = [...seen, ...chosen.map((d) => d.id)].slice(-500);
      console.log(`  episode: ${items.length} item(s), ${(audio.length / 1e6).toFixed(1)} MB`);
    } catch (e) {
      // One sphere failing must never take the others down.
      console.error(`  sphere "${sphere.id}" failed: ${e.message}`);
    }
  }

  console.log(`\n=== Feed ===`);
  let feed = [];
  try {
    feed = await buildFeed(allCoverage, { deepseek, today, limits: config.limits });
  } catch (e) {
    console.error(`  feed failed: ${e.message}`);
  }

  // One image for the whole brief: the top feed entry's own og:image, fetched
  // from the article the entry leads with. Everything below it stays text.
  // A picture that is not of the story is decoration, and decoration on a brief
  // implies a photograph nobody took.
  const lead = feed[0];
  if (lead && !lead.image) {
    const link = lead.sources?.[0]?.link ?? lead.coverage?.[0]?.link;
    if (link) {
      lead.image = await fetchArticleImage(link);
      console.log(lead.image ? `Lead image: ${lead.image.slice(0, 70)}` : 'Lead image: none (no og:image)');
    }
  }

  // Ledger rows for everything published. Written before feed.json so that a
  // crash while writing the payload still leaves a record of what was made.
  //
  // mode/patterns/question are null for today's items: nothing sets them yet.
  // They are recorded anyway so that the column exists from the first row, and
  // the deep-dive loop has somewhere to land when the researcher ships.
  for (const ep of episodes) {
    for (const item of ep.items ?? []) {
      await recordItem(run, {
        id: item.id,
        sphere: ep.sphere,
        tier: 'pod',
        kind: item.kind ?? 'news',
        mode: item.mode ?? null,
        patterns: item.patterns ?? [],
        question: item.question ?? null,
        score: item.score ?? null,
        thin: item.thin ?? false,
        audio: Boolean(ep.audioUrl),
        sources: item.coverage ?? item.sources ?? []
      });
    }
  }
  for (const entry of feed) {
    await recordItem(run, {
      id: entry.id,
      sphere: entry.sphere,
      tier: 'feed',
      kind: 'news',
      sources: entry.sources ?? entry.coverage ?? []
    });
  }

  const payload = { date: today, builtAt: new Date().toISOString(), episodes, feed };
  await writeFile(new URL('../docs/feed.json', import.meta.url), JSON.stringify(payload, null, 2));
  await writeFile(new URL('../docs/seen.json', import.meta.url), JSON.stringify(seenState, null, 2));
  await writeFile(
    new URL('../docs/unresolved-terms.json', import.meta.url),
    JSON.stringify({ updatedAt: new Date().toISOString(), terms: [...new Set([...unresolvedKnown, ...unresolvedSink])].sort() }, null, 2)
  );
  await writeFile(new URL('../out/feed.json', import.meta.url), JSON.stringify(payload, null, 2));

  const r = research.stats();
  console.log(`\nDone: ${episodes.length} episode(s), ${feed.length} feed entries`);
  console.log(`Research: ${r.queries} quer${r.queries === 1 ? 'y' : 'ies'} (${r.live ? r.provider : 'disabled'})`);
  await finishRun(run, {
    feedsAnswered: null,
    feedsTried: null,
    itemsSwept: allCoverage.length,
    clusters: feed.length
  });

  if (!episodes.length && !feed.length) {
    console.error('Nothing was produced at all. Failing so it surfaces in Actions.');
    process.exit(1);
  }
}

main().catch(async (e) => {
  console.error(e);
  // A crashed run still spent money. Closing the ledger here is the difference
  // between a budget you can audit and one that only counts the good days.
  try {
    await finishRun(run, { error: String(e?.message ?? e) });
  } catch { /* ledger write failed too - nothing further to try */ }
  process.exit(1);
});
