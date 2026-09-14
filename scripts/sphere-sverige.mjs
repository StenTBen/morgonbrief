/**
 * sverige - Sveriges politik.
 *
 * Replaces val2026. Runs once a night inside run.mjs's ordinary sphere loop,
 * like congress, crypto and world. There is no pulse, no window, no separate
 * entry point and no cross-run ledger: the half-hourly cadence existed to build
 * a time series on election day, and a sphere that runs once a day does not
 * have one. Counting "frequency" over a single run is counting outlets under a
 * grander name, so the pattern gates went with the pulse rather than being
 * retuned into something that measures nothing.
 *
 * WHAT REPLACED THEM. val2026 ranked candidates by how often a link recurred
 * across runs. This sphere ranks by how many independent outlets carried the
 * story, and then spends its effort on depth rather than on selection: full
 * text of the coverage, plus an independent retrieval pass that goes looking
 * for material nobody in the cluster cited.
 *
 * FOUR PROVENANCE TIERS, and the fourth is the point.
 *   verified     the text cites a primary document
 *   reported     a named outlet asserts it under its own byline
 *   circulating  an unconfirmed claim in circulation, described AS circulation
 *   tolkning     the pipeline's own reading, from sources it went and found
 *
 * `tolkning` is the only tier where this system says something the coverage did
 * not. That is a real departure from "the model only restates its material", so
 * it is fenced rather than trusted: tolkning content may only come from the
 * research material, it is passed to the model in a separate block from the
 * coverage, the model must tag every fact, and any fact tagged tolkning that
 * the arithmetic below cannot trace back to a research source is dropped before
 * it reaches the script. The model reports; the code still decides.
 *
 * WHAT IT DOES NOT DO. It does not let the model answer from memory. Nothing
 * here relaxes that rule - the research pass widens the material, it does not
 * remove the requirement that every claim come from material in context.
 */

import { clusterItems, fetchArticleText, fetchArticleImage, scriptSystemPrompt } from './lib.mjs';

export const PROVENANCE = ['verified', 'reported', 'circulating', 'tolkning'];

const D = {
  maxCoverageItems: 300,
  articlesPerStory: 5,
  articleMaxChars: 16000,
  articleBodyCharsInPrompt: 12000,
  tokensEntry: 16000,
  tokensScript: 16000
};

const slug = (s) => Buffer.from(String(s)).toString('base64url').slice(0, 24);

// ------------------------------------------------------------------ selection

/**
 * Caps how many items any one outlet may contribute before clustering.
 *
 * Measured on the election-window ledger: hd.se and sydsvenskan.se together
 * produced 31 percent of everything swept, and they are two Skane papers under
 * one owner running substantially shared copy. Uncapped, a national politics
 * sphere clusters around whatever the largest regional desk published most of.
 * The cap is arithmetic and deterministic, which is why it is preferred to
 * deleting a paper from the feed list - deleting decides that an outlet is
 * uninteresting, capping only decides that no outlet votes twice as loudly as
 * the rest.
 *
 * Items are sorted newest first beforehand, so the cap keeps the freshest.
 */
export function capPerSource(items, max) {
  if (!max || max <= 0) return items;
  const seen = new Map();
  const out = [];
  for (const it of items) {
    const n = seen.get(it.source) ?? 0;
    if (n >= max) continue;
    seen.set(it.source, n + 1);
    out.push(it);
  }
  return out;
}

export function chooseClusters(coverage, sphere, L) {
  const byDate = [...coverage].sort(
    (a, b) => Date.parse(b.publishedAt ?? 0) - Date.parse(a.publishedAt ?? 0)
  );
  const capped = capPerSource(byDate, sphere.maxItemsPerSource).slice(0, L.maxCoverageItems);

  const clusters = clusterItems(capped)
    .filter((c) => c.sourceCount >= (sphere.minSources ?? 2))
    .sort((a, b) => b.sourceCount - a.sourceCount);

  console.log(`  ${coverage.length} swept -> ${capped.length} after the per-source cap (${sphere.maxItemsPerSource ?? 'none'}) -> ${clusters.length} cluster(s) carried by ${sphere.minSources ?? 2}+ outlets`);
  if (capped.length && clusters.length > capped.length * 0.8) {
    console.log('  WARNING: clustering is not grouping - source counts will inflate');
  }
  return clusters;
}

// ------------------------------------------------------------------- research

const QUERY_STOP = new Set([
  'och', 'att', 'det', 'som', 'för', 'med', 'har', 'den', 'till', 'inte', 'var', 'kan', 'ett',
  'säger', 'efter', 'från', 'sig', 'under', 'mot', 'över', 'vid', 'blir', 'hade', 'ska', 'här',
  'nya', 'nytt', 'stor', 'stora', 'detta', 'dessa', 'blev', 'about', 'after', 'says', 'with'
]);

/**
 * Builds the search query from the cluster, deterministically.
 *
 * A model call would write a better query, but it would also be a model
 * choosing what gets researched - which is the one decision this architecture
 * keeps away from it everywhere else. The lead headline already contains the
 * actors and the event, which is what the query needs; the tokens are taken in
 * document order so the phrase still reads like a phrase.
 */
export function queryFor(cluster, maxWords = 10) {
  const title = cluster.items?.[0]?.title ?? '';
  const words = title
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !QUERY_STOP.has(w.toLowerCase()));
  return words.slice(0, maxWords).join(' ');
}

// -------------------------------------------------------------------- writing

const ENTRY_SYSTEM_SUFFIX = [
  '',
  'PROVENANCE - this is the rule the sphere exists to keep.',
  'Every fact you report carries exactly one tag:',
  '  "verified"     the supplied text cites a primary document',
  '  "reported"     a named outlet asserts it under its own byline',
  '  "circulating"  an unconfirmed claim in circulation',
  '  "tolkning"     it came from the RESEARCH block, not from the coverage',
  '',
  'A fact from the COVERAGE block may never be tagged tolkning. A fact from the',
  'RESEARCH block may never be tagged verified or reported. Never merge a',
  'coverage fact and a research fact into one sentence. If the RESEARCH block is',
  'empty, write the entry without a tolkning tier and do not remark on its',
  'absence. Never state anything that is in neither block - you have no memory',
  'of this subject and must not write as though you do.'
].join('\n');

/**
 * One call per cluster: the entry, with every fact tagged.
 *
 * The word "json" appears in this prompt on purpose and must stay. DeepSeek
 * rejects response_format json_object outright when neither the system nor the
 * user message contains it - documented at api-docs.deepseek.com/guides/json_mode,
 * and measured here: every entry write in the election window returned 400 for
 * exactly this reason and the sphere published nothing for two days while
 * logging what looked like a quiet news cycle. lib.mjs now guards it centrally
 * as well; this is the belt to that braces.
 */
export async function writeEntry(cluster, research, sphere, config, { deepseek, L }) {
  const sources = [...new Map(
    cluster.items.map((it) => [it.link, { source: it.source, title: it.title, link: it.link }])
  ).values()].slice(0, L.articlesPerStory);

  const bodies = await Promise.all(
    sources.map((s) => fetchArticleText(s.link, { maxChars: L.articleMaxChars }))
  );
  const fetched = bodies.filter(Boolean).length;
  console.log(`  coverage: full text for ${fetched}/${sources.length} source(s)`);

  const image = sources[0] ? await fetchArticleImage(sources[0].link) : null;

  const coverageBlock = sources.map((s, i) => ({
    source: s.source,
    title: s.title,
    body: bodies[i] ? bodies[i].slice(0, L.articleBodyCharsInPrompt) : null
  }));

  const researchBlock = research.map((r) => ({
    site: r.host,
    title: r.title,
    body: r.body ? r.body.slice(0, L.articleBodyCharsInPrompt) : r.snippet
  }));

  const out = await deepseek(
    [
      { role: 'system', content: scriptSystemPrompt(sphere, config) + '\n' + ENTRY_SYSTEM_SUFFIX },
      {
        role: 'user',
        content:
          `COVERAGE - what Swedish outlets published (${sources.length} källor):\n` +
          `${JSON.stringify(coverageBlock, null, 1)}\n\n` +
          `RESEARCH - independently retrieved, cited by none of the above (${researchBlock.length} träffar):\n` +
          `${JSON.stringify(researchBlock, null, 1)}\n\n` +
          'Skriv posten. Svara med enbart ett json-objekt i denna form:\n' +
          '{"kategori":"ETT SVENSKT ORD I VERSALER",' +
          '"rubrik":"...",' +
          '"sammanfattning":"texten, flera stycken",' +
          '"tolkning":"ett stycke som enbart vilar på RESEARCH, eller tom sträng om RESEARCH var tomt",' +
          '"fakta":[{"tag":"verified|reported|circulating|tolkning","text":"...","kalla":"outlet eller domän"}]}\n' +
          'kalla måste namnge var faktumet kom ifrån. Tomma listor och tomma strängar är giltiga svar.'
      }
    ],
    { json: true, maxTokens: L.tokensEntry, role: 'sverige-entry' }
  );

  const facts = Array.isArray(out.fakta) ? out.fakta : [];
  const researchHosts = new Set(research.map((r) => r.host));

  /**
   * The arithmetic that makes the label mean something.
   *
   * A tolkning fact whose source is not a host the researcher actually
   * returned did not come from the research block, whatever the model tagged
   * it. Dropped rather than downgraded: re-tagging it would be this code
   * guessing where it came from, and an untraceable fact under a label that
   * claims independent sourcing is worse than no fact.
   */
  const kept = [];
  let dropped = 0;
  for (const f of facts) {
    const tag = PROVENANCE.includes(f?.tag) ? f.tag : null;
    const kalla = String(f?.kalla ?? '').toLowerCase();
    if (!tag || !f?.text) { dropped += 1; continue; }
    if (tag === 'tolkning' && ![...researchHosts].some((h) => kalla.includes(h) || h.includes(kalla))) {
      dropped += 1;
      continue;
    }
    kept.push({ tag, text: String(f.text), kalla: String(f.kalla ?? '') });
  }
  if (dropped) console.log(`  provenance: ${dropped} fact(s) dropped as untraceable, ${kept.length} kept`);

  const byTier = Object.fromEntries(
    PROVENANCE.map((t) => [t, kept.filter((f) => f.tag === t).length])
  );
  const tolkning = byTier.tolkning ? String(out.tolkning ?? '') : '';

  const prose = `${out.rubrik ?? ''} ${out.sammanfattning ?? ''} ${tolkning}`;
  const words = prose.trim().split(/\s+/).filter(Boolean).length;

  console.log(`  tiers: verified ${byTier.verified}, reported ${byTier.reported}, circulating ${byTier.circulating}, tolkning ${byTier.tolkning}`);

  return {
    id: `feed-sverige-${slug(cluster.id)}`,
    sphere: 'sverige',
    kategori: (out.kategori || 'POLITIK').toUpperCase().slice(0, 24),
    rubrik: out.rubrik ?? cluster.items[0]?.title ?? '',
    sammanfattning: out.sammanfattning ?? '',
    // `synthes` is the field the app already renders under the summary. The
    // tolkning paragraph goes there rather than into a new field nothing
    // displays - a provenance tier the reader never sees protects nobody.
    synthes: tolkning,
    fakta: kept,
    tiers: byTier,
    hasTolkning: byTier.tolkning > 0,
    image,
    leadSource: sources[0]?.source ?? '',
    publishedAt: new Date().toISOString(),
    readMinutes: Math.max(1, Math.round(words / 180)),
    sourceCount: cluster.sourceCount,
    singleSource: cluster.sourceCount < 2,
    enriched: fetched > 0,
    researched: research.length > 0,
    sources,
    researchSources: research.map((r) => ({ source: r.host, title: r.title, link: r.url }))
  };
}

/** The spoken episode, stitched from the entries this run just wrote. */
export async function writeEpisodeScript(entries, sphere, config, { deepseek, L }) {
  return deepseek(
    [
      { role: 'system', content: scriptSystemPrompt(sphere, config) },
      {
        role: 'user',
        content:
          'Skriv dagens avsnitt utifrån posterna nedan. Upprepa dem inte ordagrant - foga ihop dem ' +
          'till ett sammanhängande avsnitt.\n\n' +
          'Fakta märkta "tolkning" kommer från fristående research, inte från bevakningen. Säg det ' +
          'rakt ut när du använder dem: att detta inte stod i bevakningen utan kommer från en annan ' +
          'källa, och vilken. Blanda aldrig ett tolkningsfaktum och ett bevakningsfaktum i samma ' +
          'mening. Där en post saknar tolkningsfakta ska inget sägas om saken.\n\n' +
          JSON.stringify(
            entries.map((e) => ({
              rubrik: e.rubrik,
              sammanfattning: e.sammanfattning,
              tolkning: e.synthes,
              fakta: e.fakta,
              kallor: e.sources.map((s) => s.source),
              researchKallor: e.researchSources.map((s) => s.source)
            })),
            null,
            1
          )
      }
    ],
    { maxTokens: L.tokensScript, role: 'sverige-script' }
  );
}

// ----------------------------------------------------------------------- main

/**
 * The whole nightly episode. Called by run.mjs's sphere loop.
 *
 * Takes the `coverage` run.mjs already swept and does NOT sweep again. val2026
 * did: run.mjs swept its 28 feeds, passed the result in, and podVal2026 ignored
 * the argument and swept the same 28 feeds a second time. Two full sweeps a
 * night for one episode.
 *
 * Returns `feedCoverage` - the clustered items only, not everything swept.
 * val2026 returned nothing here, so run.mjs fell through to `coverage` and the
 * sphere's entire sweep went into buildFeed. That is why it was the largest
 * post in the pipeline: not because it found the most, but because it filtered
 * the least.
 */
export async function runEpisode(sphere, coverage, seen, { deepseek, config, research }) {
  const L = { ...D, ...(config.limits ?? {}), ...(sphere.limits ?? {}) };

  const clusters = chooseClusters(coverage, sphere, L)
    .filter((c) => !seen.has(`sverige-${slug(c.id)}`))
    .slice(0, sphere.maxItemsPerEpisode ?? 3);

  if (!clusters.length) {
    console.log('  nothing carried by enough outlets - no episode material');
    return { chosen: [], script: '', items: [], feedCoverage: [] };
  }

  for (const c of clusters) {
    console.log(`    ${c.sourceCount} källor :: ${c.items[0].title.slice(0, 70)}`);
  }

  const entries = [];
  for (const cluster of clusters) {
    try {
      const query = queryFor(cluster);
      const hits = await research(query, { domains: sphere.researchDomains ?? [] });
      entries.push(await writeEntry(cluster, hits, sphere, config, { deepseek, L }));
    } catch (e) {
      // One cluster failing costs one entry, never the episode.
      console.log(`  cluster ${cluster.id}: failed - ${e.message}`);
    }
  }

  if (!entries.length) {
    console.log('  every entry failed to write - no episode');
    return { chosen: [], script: '', items: [], feedCoverage: [] };
  }

  const script = await writeEpisodeScript(entries, sphere, config, { deepseek, L });

  return {
    chosen: entries.map((e) => ({ id: `sverige-${e.id.replace(/^feed-sverige-/, '')}` })),
    script,
    items: entries,
    // Only what was actually written about reaches the general feed.
    feedCoverage: clusters.flatMap((c) => c.items)
  };
}
