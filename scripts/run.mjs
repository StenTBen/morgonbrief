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
import { req, makeDeepseek, sweepMedia, scriptSystemPrompt } from './lib.mjs';
import { speakable } from './speakable.mjs';
import { synthesizeGemini } from './synthesize-gemini.mjs';
import { buildFeed } from './feed.mjs';
import * as Congress from './sphere-congress.mjs';
import * as Val from './sphere-val2026.mjs';
import * as Crypto from './sphere-crypto.mjs';
import * as World from './sphere-world.mjs';

const DEEPSEEK_KEY = req('DEEPSEEK_API_KEY');
const CONGRESS_KEY = req('CONGRESS_API_KEY');
const SA = JSON.parse(req('GCP_SERVICE_ACCOUNT'));
const REPO = process.env.GITHUB_REPOSITORY || 'unknown/morgonbrief';
const AUDIO_TAG = 'audio';

const today = new Date().toISOString().slice(0, 10);
const deepseek = makeDeepseek(DEEPSEEK_KEY);

// Voice and delivery are taste decisions; they live in config.json so they can
// be changed and re-run without touching any code.
const config = JSON.parse(await readFile(new URL('../config.json', import.meta.url), 'utf8'));

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
 * primary document confirms will miss much of what actually moves. The tiers
 * from val2026 apply unchanged: a circulating claim is described as circulation,
 * never restated as fact, and never carries an item alone. Those rules live in
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

  const clusters = Val.clusterItems(items)
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
 * val2026's nightly episode.
 *
 * Unlike the others this does no sweeping of its own during the election
 * window: the pulse already swept, clustered, observed and wrote, and its
 * output sits in docs/val-ledger.json. Re-doing that work nightly would cost
 * money to arrive at the same entries.
 *
 * Outside the window the ledger goes quiet, and then this falls back to
 * sweeping the sphere's own feeds and taking the largest clusters - the pulse's
 * machinery without the pattern gates, which need a time series this sphere no
 * longer has once it runs once a day.
 */
async function podVal2026(sphere, coverage, seen) {
  const dayAgo = Date.now() - 24 * 3600 * 1000;

  let ledger = { published: [] };
  try {
    ledger = JSON.parse(await readFile(new URL('../docs/val-ledger.json', import.meta.url), 'utf8'));
  } catch { /* no pulse has run */ }

  const recent = (ledger.published ?? [])
    .filter((p) => p.entry && Date.parse(p.at) >= dayAgo)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, sphere.maxItemsPerEpisode ?? 3)
    .map((p) => p.entry);

  // Fallback, for every day that is not election day. Outside the pulse window
  // the ledger is empty, and an empty ledger used to mean no Valet episode at
  // all - which broke the four-episode requirement on day two.
  //
  // The sweep is the pulse's machinery without the pattern gates. Those gates
  // need a time series across runs, and a sphere that runs once a day does not
  // have one; counting frequency over a single run would just be counting
  // outlets under a grander name.
  if (!recent.length) {
    console.log('  ledger empty for the last 24h - falling back to a sweep of the sphere feeds');

    const items = (await sweepMedia(sphere.feeds, { windowHours: 24, label: '  valet sweep' }))
      .slice(0, config.limits?.maxCoverageItems ?? 300);

    const clusters = Val.clusterItems(items)
      .filter((c) => c.sourceCount >= 2)
      .sort((a, b) => b.sourceCount - a.sourceCount)
      .slice(0, sphere.maxItemsPerEpisode ?? 3);

    if (!clusters.length) {
      console.log('  nothing carried by two or more outlets - no episode material');
      return { chosen: [], script: '', items: [] };
    }

    console.log(`  ${clusters.length} cluster(s) from the sweep`);
    for (const c of clusters) console.log(`    ${c.sourceCount} sources :: ${c.items[0].title.slice(0, 70)}`);

    const fallbackScript = await deepseek(
      [
        { role: 'system', content: scriptSystemPrompt(sphere, config) },
        {
          role: 'user',
          content:
            'Skriv dagens avsnitt utifrån bevakningen nedan. Detta är rubriker och ingresser, inte ' +
            'fulltext och inte primärkällor - säg rakt ut att underlaget är bevakning, och påstå inget ' +
            'som inte står där.\n\n' +
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

    return {
      chosen: clusters.map((c) => ({ id: `val2026-${c.id}` })),
      script: fallbackScript,
      // No cards: these are teasers, and a card built on a teaser reads like a
      // card built on a document. The episode exists; the feed does not gain
      // entries it has not earned.
      items: []
    };
  }

  console.log(`  ${recent.length} entr(ies) from the pulse in the last 24h`);
  for (const e of recent) console.log(`    ${e.styrka} :: ${e.rubrik}`);

  const script = await deepseek(
    [
      { role: 'system', content: scriptSystemPrompt(sphere, config) },
      {
        role: 'user',
        content:
          'Skriv dagens avsnitt utifrån vad som redan publicerats i flödet under dygnet. ' +
          'Upprepa inte texterna - sammanfoga dem till ett sammanhängande avsnitt och säg vad som ' +
          'hänger ihop. Där styrkan är "tunn" ska det sägas rakt ut att underlaget var tunt.\n\n' +
          JSON.stringify(
            recent.map((e) => ({
              rubrik: e.rubrik,
              sammanfattning: e.sammanfattning,
              synthes: e.synthes,
              styrka: e.styrka,
              underlag: e.underlag
            })),
            null,
            1
          )
      }
    ],
    { maxTokens: config.limits?.tokensScript ?? 16000 }
  );

  return {
    chosen: recent.map((e) => ({ id: e.id })),
    script,
    items: recent.map((e) => ({
      id: e.id,
      rubrik: e.rubrik,
      sammanfattning: e.sammanfattning,
      varfor: e.synthes,
      documentUrl: e.sources?.[0]?.link ?? '',
      singleSource: e.singleSource,
      coverage: e.sources ?? []
    }))
  };
}

const POD_RUNNERS = { congress: podCongress, crypto: podCrypto, world: podWorld, val2026: podVal2026 };

// --------------------------------------------------------------- main

async function main() {
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

  const payload = { date: today, builtAt: new Date().toISOString(), episodes, feed };
  await writeFile(new URL('../docs/feed.json', import.meta.url), JSON.stringify(payload, null, 2));
  await writeFile(new URL('../docs/seen.json', import.meta.url), JSON.stringify(seenState, null, 2));
  await writeFile(
    new URL('../docs/unresolved-terms.json', import.meta.url),
    JSON.stringify({ updatedAt: new Date().toISOString(), terms: [...new Set([...unresolvedKnown, ...unresolvedSink])].sort() }, null, 2)
  );
  await writeFile(new URL('../out/feed.json', import.meta.url), JSON.stringify(payload, null, 2));

  console.log(`\nDone: ${episodes.length} episode(s), ${feed.length} feed entries`);
  if (!episodes.length && !feed.length) {
    console.error('Nothing was produced at all. Failing so it surfaces in Actions.');
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
