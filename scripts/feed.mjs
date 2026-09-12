/**
 * The feed tier.
 *
 * The podcast tier says no: a high threshold, primary documents, one or two
 * items. The feed says yes: everything the sweep found inside Karl's spheres,
 * clustered by story, rewritten in Swedish, and synthesised across sources.
 * Same sweep, opposite bar - which is why the threshold lives in the sphere
 * config and is never consulted here.
 *
 * Where the podcast assumes the listener already knows the news and skips
 * straight past it, the feed IS the news for these spheres. It informs.
 *
 * Copyright discipline is a quality rule as much as a legal one: entries are
 * rewritten in Karl's own reading language, never reproduced, and always
 * carry links back to the sources they came from.
 */

import { fetchArticleText } from './lib.mjs';

const MAX_ITEMS = 25;          // curated, not exhaustive
const MAX_FETCH_PER_CLUSTER = 3;
const MAX_CLUSTERS_TO_ENRICH = 18; // cap the crawling, not the feed

/**
 * Asks the model to group coverage into stories. Grouping is the step that
 * decides whether the feed reads sharp or broken - a real aggregator failing
 * here shows the same story three times with mismatched bodies.
 */
async function clusterStories(coverage, { deepseek, today }) {
  if (!coverage.length) return [];

  const digest = coverage
    .map((it, i) => `${i}. [${it.sphere}/${it.source}] ${it.title} :: ${it.summary.slice(0, 150)}`)
    .join('\n');

  const out = await deepseek(
    [
      {
        role: 'system',
        content:
          'You group news coverage into distinct stories. Two items belong to the same story only if ' +
          'they report the same underlying event, not merely the same topic or the same people. ' +
          'Two different matches in the same league are two stories. Two reports of one vote are one story. ' +
          'Every index must appear exactly once across all groups. Return strict JSON only.'
      },
      {
        role: 'user',
        content:
          `Today is ${today}.\n\nCoverage:\n${digest}\n\n` +
          'Return {"stories":[{"itemIndexes":[0,4,9],"label":"short English label","importance":1-5}]}\n\n' +
          'importance: 5 = a major development many outlets covered, 1 = a minor single-outlet note. ' +
          'Judge importance by how much independent coverage it drew and how consequential the event is, ' +
          'not by how dramatic the headline sounds.'
      }
    ],
    { json: true, maxTokens: 3000 }
  );

  const stories = Array.isArray(out.stories) ? out.stories : [];

  // Deterministic guard: the model can repeat or drop an index, so rebuild the
  // clusters from what it returned rather than trusting the grouping wholesale.
  const used = new Set();
  const clusters = [];
  for (const s of stories) {
    const items = (s.itemIndexes ?? [])
      .filter((i) => Number.isInteger(i) && coverage[i] && !used.has(i))
      .map((i) => { used.add(i); return coverage[i]; });
    if (items.length) clusters.push({ label: s.label ?? '', importance: Number(s.importance) || 1, items });
  }
  // Anything the model forgot becomes its own single-source story rather than vanishing.
  coverage.forEach((it, i) => {
    if (!used.has(i)) clusters.push({ label: it.title, importance: 1, items: [it] });
  });

  console.log(`Feed: ${coverage.length} items clustered into ${clusters.length} stories`);
  return clusters;
}

/** Sources-first ranking: what several outlets independently covered outranks a lone report. */
function rank(clusters) {
  return clusters
    .map((c) => ({ ...c, sourceCount: new Set(c.items.map((i) => i.source)).size }))
    .sort((a, b) =>
      b.sourceCount - a.sourceCount ||
      b.importance - a.importance ||
      b.items.length - a.items.length
    );
}

/** Real synthesis needs real sentences, so multi-source stories get their articles fetched. */
async function enrich(clusters) {
  let fetched = 0, failed = 0;

  for (const cluster of clusters.slice(0, MAX_CLUSTERS_TO_ENRICH)) {
    if (cluster.sourceCount < 2) continue;
    const targets = cluster.items.slice(0, MAX_FETCH_PER_CLUSTER);
    const texts = await Promise.all(targets.map((it) => fetchArticleText(it.link)));
    targets.forEach((it, i) => {
      if (texts[i]) { it.fullText = texts[i]; fetched++; } else { failed++; }
    });
  }

  console.log(`Feed: fetched article text for ${fetched} source(s), ${failed} unavailable (paywall or block)`);
  return clusters;
}

async function writeEntries(clusters, { deepseek }) {
  if (!clusters.length) return [];

  const material = clusters.map((c, i) => ({
    clusterIndex: i,
    sphere: c.items[0].sphere,
    sourceCount: c.sourceCount,
    sources: c.items.map((it) => ({
      source: it.source,
      title: it.title,
      summary: it.summary,
      // Full text where we have it; the RSS teaser where we do not.
      body: it.fullText ? it.fullText.slice(0, 5000) : null
    }))
  }));

  const out = await deepseek(
    [
      {
        role: 'system',
        content:
          'You write Swedish news entries for a reader who follows these subjects closely. ' +
          'Rules:\n' +
          '1. Rewrite entirely in your own words. Never reproduce sentences or distinctive phrasing from the sources.\n' +
          '2. Use only what is in the supplied material. Never add background you were not given.\n' +
          '3. When sources disagree on a fact, say so explicitly rather than picking one silently.\n' +
          '4. When only one source reports something the others do not, attribute it to that source.\n' +
          '5. No hype, no editorialising, no investment advice. Plain, precise Swedish.\n' +
          'Return strict JSON only.'
      },
      {
        role: 'user',
        content:
          `Material:\n${JSON.stringify(material, null, 1)}\n\n` +
          'Return {"entries":[{"clusterIndex":0,"kategori":"ONE WORD","rubrik":"...","sammanfattning":"3-5 ' +
          'sentences covering what happened and the substance behind it","synthes":"one sentence on what the ' +
          'sources add to or contradict in each other, or empty string when they simply agree"}]}\n\n' +
          'kategori is a single Swedish word in capitals describing the subject area, chosen freely to fit ' +
          'the story - for example POLITIK, EKONOMI, TEKNIK, GEOPOLITIK, REGLERING, MARKNAD, JURIDIK. ' +
          'All values in Swedish. Write one entry per cluster.'
      }
    ],
    { json: true, maxTokens: 8000 }
  );

  const entries = Array.isArray(out.entries) ? out.entries : [];

  return entries
    .map((e) => {
      const cluster = clusters[e.clusterIndex];
      if (!cluster) return null;
      const prose = `${e.rubrik ?? ''} ${e.sammanfattning ?? ''} ${e.synthes ?? ''}`;
      const words = prose.trim().split(/\s+/).filter(Boolean).length;
      const lead = cluster.items[0];
      return {
        id: `feed-${lead.sphere}-${Buffer.from(cluster.label || lead.title).toString('base64url').slice(0, 24)}`,
        sphere: lead.sphere,
        kategori: (e.kategori || cluster.label || '').toUpperCase().slice(0, 24),
        rubrik: e.rubrik ?? lead.title,
        sammanfattning: e.sammanfattning ?? '',
        synthes: e.synthes ?? '',
        // Design metadata: the lead source, when it ran, a thumbnail if any feed
        // carried one, and a read time derived from the prose we actually wrote.
        leadSource: lead.source,
        publishedAt: lead.publishedAt ?? null,
        image: cluster.items.map((it) => it.image).find(Boolean) ?? null,
        readMinutes: Math.max(1, Math.round(words / 180)),
        sourceCount: cluster.sourceCount,
        singleSource: cluster.sourceCount < 2,
        enriched: cluster.items.some((it) => it.fullText),
        sources: cluster.items.slice(0, 6).map((it) => ({ source: it.source, title: it.title, link: it.link }))
      };
    })
    .filter(Boolean);
}

export async function buildFeed(coverage, { deepseek, today }) {
  if (!coverage.length) return [];
  const clusters = rank(await clusterStories(coverage, { deepseek, today }));
  const top = clusters.slice(0, MAX_ITEMS);
  await enrich(top);
  const entries = await writeEntries(top, { deepseek });
  console.log(`Feed: ${entries.length} entries written`);
  return entries;
}
