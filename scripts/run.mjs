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

const DEEPSEEK_KEY = req('DEEPSEEK_API_KEY');
const CONGRESS_KEY = req('CONGRESS_API_KEY');
const SA = JSON.parse(req('GCP_SERVICE_ACCOUNT'));
const REPO = process.env.GITHUB_REPOSITORY || 'unknown/morgonbrief';
const AUDIO_TAG = 'audio';

const today = new Date().toISOString().slice(0, 10);
const deepseek = makeDeepseek(DEEPSEEK_KEY);

// --------------------------------------------------------------- pod tier

async function podCongress(sphere, coverage, seen) {
  const candidates = await Congress.linkCoverage(coverage, { deepseek, today });
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
    Congress.writeCards(chosen, { deepseek }),
    Congress.writeScript(chosen, sphere, { deepseek, today })
  ]);
  return { chosen, script, items: chosen.map((d) => Congress.cardFromDoc(d, cards.find((c) => c.id === d.id) ?? {})) };
}

async function podCrypto(sphere, coverage, seen) {
  const governanceIndex = await Crypto.loadGovernanceIndex(sphere);
  const candidates = await Crypto.linkCoverage(coverage, { deepseek, today, governanceIndex, sphere });
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
    Crypto.writeCards(chosen, { deepseek }),
    Crypto.writeScript(chosen, sphere, { deepseek, today })
  ]);
  return { chosen, script, items: chosen.map((d) => Crypto.cardFromDoc(d, cards.find((c) => c.id === d.id) ?? {})) };
}

function pick(scored, sphere) {
  const chosen = scored.filter((d) => d.qualifies).sort((a, b) => b.score - a.score).slice(0, sphere.maxItemsPerEpisode);
  console.log(`  scored ${scored.length}, qualified ${chosen.length}`);
  for (const d of chosen) console.log(`    ${d.score} ${d.id} :: ${d.reasons.join(', ')}`);
  return chosen;
}

const POD_RUNNERS = { congress: podCongress, crypto: podCrypto };

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
      allCoverage.push(...coverage);

      const runner = POD_RUNNERS[sphere.id];
      if (!runner) { console.log(`  no pod runner for "${sphere.id}", feed only`); continue; }

      const seen = new Set(seenState[sphere.id] ?? []);
      const { chosen, script, items } = await runner(sphere, coverage, seen);
      const audio = await synthesize(script, SA);

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
    feed = await buildFeed(allCoverage, { deepseek, today });
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
