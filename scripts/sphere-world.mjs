/**
 * World sphere - defined by subtraction.
 *
 * Congress has Congress.gov. Crypto has governance forums. This sphere has no
 * primary-source API, because "a big story Sweden did not cover" is not a
 * document - it is a relationship between two bodies of coverage. So the
 * primary source here is the international reporting itself, read in full, and
 * the thing that makes a story qualify is the ABSENCE of a Swedish counterpart.
 *
 * The Swedish shadow sweep is never displayed, never quoted, never cited. It
 * exists only to be subtracted. If a story shows up there, it is not a gap.
 *
 * The model does the cross-language matching, because proper nouns alone cannot
 * tell you that "Sudan: strider i El Fasher" and "Fighting intensifies in
 * Darfur" are the same story. But the model only ever REPORTS - how many
 * outlets, whether a Swedish match exists, which region. The arithmetic in
 * score() decides what qualifies, exactly as in every other sphere.
 */

import { strip, fetchArticleText, scriptSystemPrompt } from './lib.mjs';

// Defaults only - config.json overrides every one of these.
const D = {
  maxCoverageItems: 400,
  maxSwedishShadowItems: 500,
  articlesPerStory: 5,
  articleMaxChars: 16000,
  articleBodyCharsInPrompt: 12000,
  tokensClustering: 32000,
  tokensCards: 16000,
  tokensScript: 16000
};

/**
 * Clusters international coverage and, in the same pass, checks each cluster
 * against the Swedish headlines. One call rather than two: the model needs both
 * lists in front of it anyway, and splitting them invites disagreement between
 * the clustering and the matching.
 */
export async function findGaps(coverage, swedish, { deepseek, today, sphere, limits = {} }) {
  if (!coverage.length) return [];
  const L = { ...D, ...limits };

  const intl = coverage
    .slice(0, L.maxCoverageItems)
    .map((it, i) => `${i}. [${it.source}] ${it.title} :: ${it.summary.slice(0, 200)}`)
    .join('\n');

  const se = swedish
    .slice(0, L.maxSwedishShadowItems)
    .map((it, i) => `S${i}. [${it.source}] ${it.title}`)
    .join('\n');

  const out = await deepseek(
    [
      {
        role: 'system',
        content:
          'You compare international news coverage against Swedish news coverage to find stories that ' +
          'international outlets carried but Swedish outlets did not.\n' +
          'You are matching EVENTS, not topics. Two items match only if they report the same underlying ' +
          'event. A Swedish piece about the war in Sudan in general does not match an international report ' +
          'of a specific massacre in a specific town.\n' +
          'The two lists are in different languages. Match on people, places, institutions and events, not ' +
          'on wording.\n' +
          'You report observations only. You never decide what is important. Return strict JSON only.'
      },
      {
        role: 'user',
        content:
          `Today is ${today}.\n\nINTERNATIONAL COVERAGE:\n${intl}\n\n` +
          `SWEDISH COVERAGE (for comparison only):\n${se || '(none retrieved)'}\n\n` +
          'Group the international coverage into distinct stories, then RETURN ONLY the stories that ' +
          'Swedish outlets did not properly cover. Omit every story with clear Swedish coverage entirely - ' +
          'do not list it, do not mention it. Most stories will be omitted, and that is expected.\n\n' +
          'Return {"stories":[{"itemIndexes":[0,4,9],"label":"short English label",' +
          '"region":"one of: Africa, South Asia, Southeast Asia, East Asia, Central Asia, Middle East, ' +
          'Europe, North America, Latin America, Caribbean, Pacific, Global",' +
          '"swedishCoverage":"none|weak",' +
          '"swedishMatches":[3],' +
          '"whyItMatters":"one sentence, in English, on the consequence beyond the region"}]}\n\n' +
          'swedishCoverage: "none" when nothing in the Swedish list refers to the event, "weak" when a ' +
          'single Swedish item touches it only in passing. If Swedish outlets covered it properly, the ' +
          'story does not belong in your answer at all. ' +
          'swedishMatches lists the S-indexes you matched, empty when none. ' +
          'Never list the same international index in two stories. ' +
          'An empty list is a valid answer on a day when Swedish media kept up.'
      }
    ],
    { json: true, maxTokens: L.tokensClustering, role: 'world-clustering' }
  );

  const stories = Array.isArray(out.stories) ? out.stories : [];

  // Same deterministic guard as the feed clusterer: the model can duplicate,
  // hallucinate or drop an index, and none of those may lose an article.
  const used = new Set();
  const clusters = [];
  for (const s of stories) {
    const items = (s.itemIndexes ?? [])
      .filter((i) => Number.isInteger(i) && coverage[i] && !used.has(i))
      .map((i) => { used.add(i); return coverage[i]; });
    if (!items.length) continue;
    clusters.push({
      label: s.label ?? items[0].title,
      region: s.region ?? 'Global',
      swedishCoverage: ['none', 'weak', 'full'].includes(s.swedishCoverage) ? s.swedishCoverage : 'full',
      whyItMatters: s.whyItMatters ?? '',
      items,
      sourceCount: new Set(items.map((it) => it.source)).size
    });
  }
  // Everything the model did not return is, by the instruction above, a story
  // Swedish media covered - so it is folded in here as covered rather than
  // dropped. This is the normal path for most items, not an edge case, and it
  // is also what protects us if the model simply forgets one: silence can only
  // ever mean "covered", never "gap".
  coverage.forEach((it, i) => {
    if (used.has(i)) return;
    clusters.push({
      label: it.title, region: 'Global', swedishCoverage: 'full',
      whyItMatters: '', items: [it], sourceCount: 1
    });
  });

  if (coverage.length > L.maxCoverageItems) {
    console.log(`  WARNING: ${coverage.length - L.maxCoverageItems} international items were not shown to the model (raise limits.maxCoverageItems)`);
  }
  if (swedish.length > L.maxSwedishShadowItems) {
    console.log(`  WARNING: ${swedish.length - L.maxSwedishShadowItems} Swedish items were not compared against (raise limits.maxSwedishShadowItems) - this can manufacture false gaps`);
  }
  const gaps = clusters.filter((c) => c.swedishCoverage !== 'full').length;
  console.log(`  ${coverage.length} international items -> ${clusters.length} stories, ${gaps} with little or no Swedish coverage`);
  return clusters;
}

export function score(cluster, sphere) {
  const w = sphere.scoring;
  const t = sphere.sourceThresholds;
  const reasons = [];
  let total = 0;
  const add = (points, why) => { total += points; reasons.push(`${why} (+${points})`); };

  if (cluster.sourceCount >= t.many) add(w.manyInternationalSources, `${cluster.sourceCount} international outlets`);
  else if (cluster.sourceCount >= t.some) add(w.someInternationalSources, `${cluster.sourceCount} international outlets`);

  if (cluster.swedishCoverage === 'none') add(w.noSwedishCoverage, 'No Swedish coverage found');
  else if (cluster.swedishCoverage === 'weak') add(w.weakSwedishCoverage, 'Only passing Swedish mention');

  if ((sphere.underreportedRegions ?? []).includes(cluster.region)) {
    add(w.underreportedRegion, `Underreported region (${cluster.region})`);
  }

  return { ...cluster, score: total, reasons, qualifies: total >= w.threshold };
}

/** The international articles are the primary source here, so the top stories get read in full. */
export async function enrich(clusters, limits = {}) {
  const L = { ...D, ...limits };
  let fetched = 0, failed = 0;
  for (const cluster of clusters) {
    const targets = cluster.items.slice(0, L.articlesPerStory);
    const texts = await Promise.all(targets.map((it) => fetchArticleText(it.link, { maxChars: L.articleMaxChars })));
    targets.forEach((it, i) => {
      if (texts[i]) { it.fullText = texts[i]; fetched++; } else { failed++; }
    });
  }
  console.log(`  fetched article text for ${fetched} source(s), ${failed} unavailable`);
  return clusters;
}

export async function writeCards(clusters, { deepseek, limits = {} }) {
  if (!clusters.length) return [];
  const L = { ...D, ...limits };
  return deepseek(
    [
      {
        role: 'system',
        content:
          'You write Swedish briefing entries about international stories that Swedish media did not cover. ' +
          'The reader is well informed generally but has not seen this story. Use only the supplied material. ' +
          'Rewrite entirely in your own words - never reproduce sentences from the sources. ' +
          'Do not editorialise about Swedish media. Strict JSON only.'
      },
      {
        role: 'user',
        content:
          `Material:\n${JSON.stringify(
            clusters.map((c, i) => ({
              index: i,
              label: c.label,
              region: c.region,
              outlets: c.sourceCount,
              whyItMatters: c.whyItMatters,
              sources: c.items.slice(0, L.articlesPerStory).map((it) => ({
                source: it.source,
                title: it.title,
                summary: it.summary,
                body: it.fullText ? it.fullText.slice(0, L.articleBodyCharsInPrompt) : null
              }))
            })),
            null,
            1
          )}\n\n` +
          'Return {"cards":[{"index":0,"kategori":"ONE SWEDISH WORD IN CAPITALS","rubrik":"...",' +
          '"sammanfattning":"3-5 sentences: what happened, where, and the substance behind it",' +
          '"varfor":"1-2 sentences on why it matters beyond the region",' +
          '"status":"one clause on where this stands right now"}]} All values in Swedish.'
      }
    ],
    { json: true, maxTokens: L.tokensCards, role: 'world-cards' }
  ).then((r) => (Array.isArray(r.cards) ? r.cards : []));
}

export async function writeScript(clusters, sphere, { deepseek, today, config = {} }) {
  const L = { ...D, ...(config.limits ?? {}) };
  if (!clusters.length) {
    return (
      'God morgon. Inget internationellt ämne klarade tröskeln idag. Det som var stort ute i världen ' +
      'har svensk press också rapporterat, och då finns det ingen lucka att fylla. Vi hörs imorgon.'
    );
  }

  return deepseek([
    { role: 'system', content: scriptSystemPrompt(sphere, config) },
    {
      role: 'user',
      content:
        `Date: ${today}.\n\nMaterial (this is your only permitted source of fact):\n` +
        JSON.stringify(
          clusters.map((c) => ({
            label: c.label,
            region: c.region,
            outletCount: c.sourceCount,
            whyItMatters: c.whyItMatters,
            sources: c.items.slice(0, L.articlesPerStory).map((it) => ({
              source: it.source,
              title: it.title,
              summary: it.summary,
              body: it.fullText ? it.fullText.slice(0, L.articleBodyCharsInPrompt) : null
            }))
          })),
          null,
          1
        ) +
        '\n\nWrite the full spoken script. If there is more than one subject, each gets its own complete ANNOUNCE / GROUND / SUBSTANCE segment, and you move between them with a plain handover that names the next subject - never a linking sentence that implies the two are connected. ' +
        'Close the episode by saying plainly which claims rest on a single outlet. Plain text only.'
    }
  ], { maxTokens: L.tokensScript, role: 'world-script' });
}

export function cardFromCluster(c, card) {
  return {
    id: `world-${Buffer.from(c.label).toString('base64url').slice(0, 24)}`,
    kategori: card.kategori ?? c.region.toUpperCase(),
    rubrik: card.rubrik ?? c.label,
    sammanfattning: card.sammanfattning ?? '',
    varfor: card.varfor ?? c.whyItMatters,
    status: card.status ?? '',
    score: c.score,
    reasons: c.reasons,
    region: c.region,
    swedishCoverage: c.swedishCoverage,
    leadSource: c.items[0]?.source ?? '',
    publishedAt: c.items[0]?.publishedAt ?? null,
    singleSource: c.sourceCount < 2,
    enriched: c.items.some((it) => it.fullText),
    sourceCount: c.sourceCount,
    coverage: c.items.slice(0, 6).map((it) => ({ source: it.source, title: it.title, link: it.link }))
  };
}
