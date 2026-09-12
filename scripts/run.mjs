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
import { req, makeDeepseek, sweepMedia, synthesize } from './lib.mjs';
import { buildFeed } from './feed.mjs';
import * as Congress from './sphere-congress.mjs';
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

function pick(scored, sphere) {
  const chosen = scored.filter((d) => d.qualifies).sort((a, b) => b.score - a.score).slice(0, sphere.maxItemsPerEpisode);
  console.log(`  scored ${scored.length}, qualified ${chosen.length}`);
  for (const d of chosen) console.log(`    ${d.score} ${d.id} :: ${d.reasons.join(', ')}`);
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
  const chosen = fresh.filter((c) => c.qualifies).sort((a, b) => b.score - a.score).slice(0, sphere.maxItemsPerEpisode);

  console.log(`  scored ${scored.length}, gaps ${gaps.length}, qualified ${chosen.length}`);
  for (const c of chosen) console.log(`    ${c.score} ${c.label} :: ${c.reasons.join(', ')}`);

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

const POD_RUNNERS = { congress: podCongress, crypto: podCrypto, world: podWorld };

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
      const audio = await synthesize(script, SA, config.voice);

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
  await writeFile(new URL('../out/feed.json', import.meta.url), JSON.stringify(payload, null, 2));

  console.log(`\nDone: ${episodes.length} episode(s), ${feed.length} feed entries`);
  if (!episodes.length && !feed.length) {
    console.error('Nothing was produced at all. Failing so it surfaces in Actions.');
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
