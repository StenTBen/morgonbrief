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
  selectFrom: 10,
  tokensSelect: 4000,
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

/**
 * An acronym: one to four characters, all capitals.
 *
 * Swedish party names ARE these letters. C, M, S, V, L, KD, MP, SD - the
 * actors in almost every domestic political story are below the length floor
 * the query builders use to throw away noise, so "C stänger dörren till M"
 * became the query "stänger dörren", which names nobody and searches for a
 * figure of speech. Both parties, the entire subject of the story, were
 * discarded before the search ran.
 *
 * Kept regardless of position, which is what separates this from the
 * proper-noun rule below: a capitalised word at the start of a sentence is
 * capitalised because the sentence starts, but an all-capital token is an
 * acronym wherever it sits. The rule generalises past parties to EU, FN, SVT,
 * MSB, SKR - which is the point, since those are exactly the institutions a
 * restricted search on riksdagen.se or regeringen.se needs to be given.
 */
const ACRONYM = /^[A-ZÅÄÖ]{1,4}$/;

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
/**
 * The few terms that name the SUBJECT rather than the event.
 *
 * The open query is the headline; this is not. A site-restricted search against
 * ten small policy domains for "Regeringen backar om utredningen efter kritik"
 * returns nothing, every time - nobody publishes under today's headline. What
 * those sites publish under is the actor and the policy area, so that is what
 * goes in: proper nouns first (mid-sentence capitals, which in Swedish means
 * names and institutions rather than sentence openings), then the longest
 * remaining words, which in a compounding language are the specific ones.
 */
export function topicQueryFor(cluster, maxWords = 4) {
  const titles = cluster.items.slice(0, 4).map((it) => it.title ?? '');
  const counts = new Map();
  const proper = new Set();

  const acronyms = new Set();
  for (const title of titles) {
    const words = title.replace(/[^\p{L}\p{N}\s-]/gu, ' ').split(/\s+/).filter(Boolean);
    words.forEach((w, i) => {
      if (ACRONYM.test(w)) { acronyms.add(w); return; }
      if (w.length < 4 || QUERY_STOP.has(w.toLowerCase())) return;
      // Position 0 is capitalised because it starts the sentence, not because
      // it is a name - taking it would put "Regeringen" in every query.
      if (i > 0 && /^\p{Lu}/u.test(w)) proper.add(w);
      counts.set(w.toLowerCase(), (counts.get(w.toLowerCase()) ?? 0) + 1);
    });
  }

  const ranked = [...counts.keys()].sort(
    (a, b) => (counts.get(b) - counts.get(a)) || (b.length - a.length)
  );
  // Acronyms first: they are the most specific tokens available and the ones a
  // site-restricted search most needs, and maxWords is small enough that
  // ordering decides what survives.
  const picked = [...acronyms, ...proper];
  for (const w of ranked) {
    if (picked.length >= maxWords) break;
    if (!picked.some((p) => p.toLowerCase() === w)) picked.push(w);
  }
  return picked.slice(0, maxWords).join(' ');
}

export function queryFor(cluster, maxWords = 10) {
  const title = cluster.items?.[0]?.title ?? '';
  const words = title
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter((w) => (ACRONYM.test(w) || w.length > 2) && !QUERY_STOP.has(w.toLowerCase()));
  return words.slice(0, maxWords).join(' ');
}

// ------------------------------------------------------------------ selection

const SELECT_SYSTEM = [
  'Du sållar underlag till en daglig brief om svensk politik. Du skriver ingenting som når lyssnaren.',
  '',
  'POLITISK betyder: handlar om utövandet av eller kampen om offentlig makt i Sverige.',
  'Regering, riksdag, partier, kommuner och regioner, myndigheter, lagstiftning, offentliga',
  'utgifter, val, politiska utnämningar, politiskt ansvarsutkrävande.',
  '',
  'Inte politiskt: brott, olyckor, väder, sport, kändisar, företagsnyheter, kultur - inte heller',
  'när en politiker uttalat sig om saken. En kommentar från en minister gör inte en händelse',
  'politisk. Frågan är om nyheten HANDLAR om offentlig makt, inte om en politiker råkar nämnas.',
  '',
  'VIKT 1-5 mäter hur mycket som finns bortom rubriken för någon som redan läst dagens',
  'nyheter. 5 = ett beslut eller en konflikt med verkliga följder som få har trängt in i.',
  '1 = rubriken är hela historien, eller ett rutinreferat av något alla redan sett.',
  'Ett refererande valresultat är lågt även om det är stort. Vad resultatet gör möjligt är högt.',
  '',
  'Döm varje kluster för sig. Motivera kort, på svenska, i sak - inte "intressant ämne" utan',
  'vad som faktiskt står på spel. Svara med enbart ett json-objekt.'
].join('\n');

/**
 * Picks the day's subjects with a model call, and logs why.
 *
 * The first run without this chose "Bombades före bröllopet" as Sveriges
 * politik. Nothing was broken: the sphere ranked purely on how many independent
 * outlets carried a story, its feeds are general news feeds, and a wedding
 * bombing clears three outlets easily. Source count measures pickup, and pickup
 * is not subject matter.
 *
 * The model judges each cluster; this function selects. That split is
 * deliberate and is the same one the provenance check makes: the model is asked
 * for a classification and a weight per cluster, never for a final list, so the
 * cap, the ordering and the political filter stay in code where they can be
 * read. A model asked to "pick three" would also decide how many - and would
 * return three whether or not three qualify.
 *
 * FAILS CLOSED. If the call fails, there is no episode. The obvious
 * alternative - fall back to source count - is exactly the behaviour this
 * replaces, so a silent fallback would reinstate the bug on the days the guard
 * is not working, which are the days nobody is looking. A missing episode is
 * visible and harmless; a wedding bombing filed under Sveriges politik is
 * neither.
 */
export async function selectStories(clusters, sphere, config, { deepseek, L }) {
  const pool = clusters.slice(0, L.selectFrom);
  if (!pool.length) return [];

  const brief = pool.map((c, i) => ({
    index: i,
    kallor: c.sourceCount,
    rubrik: c.items[0]?.title ?? '',
    andraRubriker: [...new Set(c.items.slice(1).map((it) => it.title))].slice(0, 3),
    ingress: (c.items[0]?.summary ?? '').slice(0, 300)
  }));

  const out = await deepseek(
    [
      { role: 'system', content: SELECT_SYSTEM },
      {
        role: 'user',
        content:
          `${JSON.stringify(brief, null, 1)}\n\n` +
          'Svara med enbart detta json-objekt:\n' +
          '{"beslut":[{"index":0,"politisk":true,"vikt":3,"varfor":"..."}]}\n' +
          'Ett beslut per kluster ovan, inget utelämnat.'
      }
    ],
    { json: true, maxTokens: L.tokensSelect, role: 'sverige-select' }
  );

  const byIndex = new Map();
  for (const d of Array.isArray(out.beslut) ? out.beslut : []) {
    const i = Number(d?.index);
    // Indices are validated rather than trusted: an index the model invented
    // would otherwise silently select the wrong cluster, or none.
    if (!Number.isInteger(i) || i < 0 || i >= pool.length || byIndex.has(i)) continue;
    byIndex.set(i, {
      political: d.politisk === true,
      weight: Math.min(5, Math.max(1, Number(d.vikt) || 1)),
      reason: String(d.varfor ?? '').slice(0, 300)
    });
  }

  if (!byIndex.size) throw new Error('selection returned no usable decisions');

  const judged = pool.map((c, i) => ({ cluster: c, index: i, ...(byIndex.get(i) ?? { political: false, weight: 1, reason: 'not judged' }) }));
  const chosen = judged
    .filter((j) => j.political)
    .sort((a, b) => b.weight - a.weight || b.cluster.sourceCount - a.cluster.sourceCount)
    .slice(0, sphere.maxItemsPerEpisode ?? 3);

  const chosenSet = new Set(chosen.map((j) => j.index));
  console.log(`  selection: ${judged.filter((j) => j.political).length}/${pool.length} political, keeping ${chosen.length}`);
  for (const j of judged) {
    const mark = chosenSet.has(j.index) ? '  VALD ' : (j.political ? '  över ' : '  BORT ');
    console.log(`  ${mark} [${j.weight}] ${j.cluster.items[0].title.slice(0, 58)}`);
    console.log(`           ${j.reason}`);
  }

  return chosen;
}

// -------------------------------------------------------------------- writing

const ENTRY_SYSTEM_SUFFIX = [
  '',
  'PROVENANCE - this is the rule the sphere exists to keep.',
  'You are given three blocks of material. Every fact you report carries exactly',
  'one tag, and which block it came from decides which tags are available:',
  '',
  '  COVERAGE  - what Swedish news outlets published about this story.',
  '              Allowed tags: "reported" (a named outlet asserts it under its',
  '              own byline), "circulating" (an unconfirmed claim, which you',
  '              describe AS circulation and never as fact), or "verified" where',
  '              the article itself quotes or cites a primary document.',
  '  DOCUMENTS - primary material retrieved directly from the source: a',
  '              proposition, a statistic, an audit, an official decision.',
  '              Allowed tag: "verified", with the domain as källa.',
  '  RESEARCH  - independent reading: analysis, columns, institute work that',
  '              nobody in the coverage cited. Allowed tag: "tolkning".',
  '',
  'RESEARCH may never be tagged verified or reported. DOCUMENTS may never be',
  'tagged tolkning - a proposition is not somebody\'s interpretation, it is the',
  'thing being interpreted. Never merge facts from two blocks into one sentence.',
  '',
  'Where a DOCUMENTS fact and a COVERAGE fact disagree, say so plainly and name',
  'both. That disagreement is usually the most valuable thing on the page, and',
  'it is the reason the documents are fetched at all.',
  '',
  'Where a block is empty, write without that tier and do not remark on its',
  'absence. Never state anything that is in none of the blocks - you have no',
  'memory of this subject and must not write as though you do.'
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

  const asBlock = (rs) => rs.map((r) => ({
    site: r.host,
    title: r.title,
    body: r.body ? r.body.slice(0, L.articleBodyCharsInPrompt) : r.snippet
  }));
  const documents = research.filter((r) => r.tier === 'document');
  const interpretation = research.filter((r) => r.tier !== 'document');

  const out = await deepseek(
    [
      { role: 'system', content: scriptSystemPrompt(sphere, config) + '\n' + ENTRY_SYSTEM_SUFFIX },
      {
        role: 'user',
        content:
          `COVERAGE - what Swedish outlets published (${sources.length} källor):\n` +
          `${JSON.stringify(coverageBlock, null, 1)}\n\n` +
          `DOCUMENTS - primary material retrieved from the source itself (${documents.length} träffar):\n` +
          `${JSON.stringify(asBlock(documents), null, 1)}\n\n` +
          `RESEARCH - independent reading, cited by nobody above (${interpretation.length} träffar):\n` +
          `${JSON.stringify(asBlock(interpretation), null, 1)}\n\n` +
          'Skriv posten. Svara med enbart ett json-objekt i denna form:\n' +
          '{"kategori":"ETT SVENSKT ORD I VERSALER",' +
          '"rubrik":"...",' +
          '"sammanfattning":"texten, flera stycken",' +
          '"tolkning":"ett stycke som enbart vilar på RESEARCH, eller tom sträng om RESEARCH var tomt",' +
          '"fakta":[{"tag":"verified|reported|circulating|tolkning","text":"...","kalla":"outlet eller domän"}]}\n' +
          'kalla måste namnge var faktumet kom ifrån — för DOCUMENTS och RESEARCH exakt den domän ' +
          'som står i blocket. Tomma listor och tomma strängar är giltiga svar.'
      }
    ],
    { json: true, maxTokens: L.tokensEntry, role: 'sverige-entry' }
  );

  const facts = Array.isArray(out.fakta) ? out.fakta : [];
  const interpretationHosts = new Set(interpretation.map((r) => r.host));
  const documentHosts = new Set(documents.map((r) => r.host));
  // Every document domain the sphere is configured to search, whether or not a
  // result came back from it tonight. A "verified" fact attributed to
  // riksdagen.se on a night riksdagen.se returned nothing did not come from
  // riksdagen.se, and that is checkable precisely because the list is known.
  const configuredDocDomains = (sphere.documentDomains ?? []).map((d) => d.toLowerCase());

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
    const cites = (hosts) => [...hosts].some((h) => kalla.includes(h) || h.includes(kalla));

    // tolkning must trace to something the researcher actually returned.
    if (tag === 'tolkning' && !cites(interpretationHosts)) { dropped += 1; continue; }

    // A verified fact citing a configured document domain must trace to a
    // document actually retrieved from it. Verified facts citing an outlet are
    // left alone: those come from coverage quoting a primary source, which this
    // code cannot check and never could.
    if (tag === 'verified' && configuredDocDomains.some((d) => kalla.includes(d)) && !cites(documentHosts)) {
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

  const researchSources = research.map((r) => ({
    source: r.host,
    title: r.title,
    link: r.url,
    // The tier the result was retrieved under, not a guess at what the model
    // did with it. ledger.mjs lists both values among the provenance it expects
    // on a source, so "how often did a primary document reach an entry" becomes
    // an answerable question over time.
    provenance: r.tier === 'document' ? 'verified' : 'tolkning'
  }));

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
    hasDocument: documents.length > 0,
    image,
    leadSource: sources[0]?.source ?? '',
    publishedAt: new Date().toISOString(),
    readMinutes: Math.max(1, Math.round(words / 180)),
    sourceCount: cluster.sourceCount,
    singleSource: cluster.sourceCount < 2,
    enriched: fetched > 0,
    researched: research.length > 0,
    // Coverage sources first, then the research sources, in ONE list.
    //
    // The app renders item.sources under "Källor", so putting the research
    // sources anywhere else would mean a tolkning paragraph the reader cannot
    // trace. A provenance tier nobody can check is decoration. `provenance` is
    // the field ledger.mjs already reserves on each source - it lists tolkning
    // among its expected values - so this also makes "how often did the
    // research tier actually contribute" an answerable question later.
    sources: [
      ...sources.map((s) => ({ ...s, provenance: null })),
      ...researchSources
    ],
    coverageSources: sources,
    researchSources
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
          'Fakta märkta "verified" med en myndighets- eller riksdagsdomän som källa är hämtade ur ' +
          'primärdokumentet självt. Det är den starkaste grunden du har — säg vad som faktiskt står ' +
          'där, och namnge dokumentet. Där det säger något annat än bevakningen är den skillnaden ' +
          'ofta hela poängen med avsnittet.\n\n' +
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

  const ranked = chooseClusters(coverage, sphere, L)
    .filter((c) => !seen.has(`sverige-${slug(c.id)}`));

  if (!ranked.length) {
    console.log('  nothing carried by enough outlets - no episode material');
    return { chosen: [], script: '', items: [], feedCoverage: [] };
  }

  let selected;
  try {
    selected = await selectStories(ranked, sphere, config, { deepseek, L });
  } catch (e) {
    // Fails closed - see selectStories. Loud, because the alternative reading
    // of a quiet "no episode" is that Sweden had no politics today.
    console.log(`  SELECTION FAILED (${e.message}) - no episode rather than an unfiltered one`);
    return { chosen: [], script: '', items: [], feedCoverage: [] };
  }

  if (!selected.length) {
    console.log('  nothing political in today\'s coverage - no episode');
    return { chosen: [], script: '', items: [], feedCoverage: [] };
  }

  const clusters = selected.map((j) => j.cluster);
  const entries = [];
  for (const { cluster, reason, weight } of selected) {
    try {
      const hits = await research({
        openQuery: queryFor(cluster),
        topicQuery: topicQueryFor(cluster),
        analysisDomains: sphere.analysisDomains ?? [],
        documentDomains: sphere.documentDomains ?? []
      });
      const entry = await writeEntry(cluster, hits, sphere, config, { deepseek, L });
      // Kept on the entry, not passed to the script writer. It is the reason
      // this subject was chosen, which is editorial reasoning about the brief -
      // handing it to the writer invites an episode that argues for its own
      // running order instead of reporting.
      entries.push({ ...entry, selectionReason: reason, selectionWeight: weight });
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
    // Nothing. Deliberately.
    //
    // buildFeed() would take these same clusters and write a SECOND entry about
    // each story - from the same articles, without the full text this sphere
    // fetched and without the tolkning tier - and the app renders pod items and
    // feed entries in one list, so both would appear. Paying a model to write a
    // worse duplicate of something already written is the wrong half of the
    // trade. The entries above still reach every view: deepItems() in the app
    // pulls episode items into the feed list, including under "Allt".
    //
    // This is also the rest of the answer to why the election sphere was the
    // largest post in the pipeline. It returned no feedCoverage at all, so
    // run.mjs fell through to the whole sweep - several hundred items of Swedish
    // domestic news into buildFeed every night. It now contributes three
    // curated entries and nothing else.
    feedCoverage: []
  };
}
