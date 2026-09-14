/**
 * research.mjs - the independent retrieval layer.
 *
 * Every other input to this pipeline arrives because an RSS feed pushed it.
 * That is a closed loop: the sphere can only ever discuss what its own feed
 * list surfaced, and it cannot say anything the coverage did not say first.
 * This module runs a query the pipeline formed itself and fetches what comes
 * back.
 *
 * THREE TIERS, BECAUSE THEY ARE NOT THE SAME KIND OF SOURCE.
 *
 *   open      unrestricted web. Whatever else is being said about the story.
 *   analysis  restricted to the think tanks, policy outlets and research
 *             institutes in the sphere's analysisDomains. Interpretation.
 *   document  restricted to riksdagen.se, regeringen.se, scb.se and the like.
 *             Primary material: the proposition itself, the statistics, the
 *             audit report.
 *
 * The first version had one tier and one query, and it found nothing: fifteen
 * small Swedish domains never rank in the top twenty for a general news query,
 * so partitioning the results client-side could not work in principle - the
 * analysis sites were never among the twenty there were to partition.
 * Restricting the query is what makes them reachable. Brave documents `site:`
 * inside the q parameter, with site:example.com covering subdomains too.
 *
 * WHY document IS SEPARATE FROM analysis. A proposition on regeringen.se is not
 * somebody's reading of the news, it IS the thing the news is about. Filing it
 * as interpretation would be the same error in the opposite direction from
 * filing interpretation as fact: the entry would hedge a primary document.
 * Tiers travel with every result so sphere-sverige can hold them to different
 * provenance rules.
 *
 * DEGRADES TO NOTHING. No key, provider 'none', a 4xx, a timeout - every path
 * returns an empty array. The sphere then publishes with the tiers it has.
 * Retrieval makes an episode better; it never decides whether there is one.
 */

import { fetchArticleText } from './lib.mjs';

const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';

// Brave documents a 400 character / 50 word ceiling on q. Held under it: the
// site: chain is built to a budget, so an over-long domain list costs domains
// rather than costing the whole query.
const Q_MAX_CHARS = 360;
const Q_MAX_WORDS = 45;

const D = {
  provider: 'none',
  // 20 is Brave's documented maximum for count. Asking for more is not an
  // error, it is simply capped, so there is nothing to gain by raising it.
  resultsPerQuery: 20,
  keepPerTier: { open: 2, analysis: 3, document: 3 },
  fetchBodies: 4,
  bodyMaxChars: 12000,
  // Brave's free tier is documented at one request per second. Serialised with
  // headroom rather than fired in parallel: a 429 costs the tier for the night,
  // and the nightly run has hours of budget to spare.
  minIntervalMs: 1100,
  timeoutMs: 15000
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Bare hostname, so a result URL can be matched against a configured domain. */
export function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
}

/**
 * True when `host` is the domain itself or a subdomain of it. A plain
 * includes() would match kvartal.se inside notkvartal.se.example, which is
 * exactly the sort of thing that puts an unrelated page under an analysis
 * label.
 */
export function matchesDomain(host, domain) {
  const d = String(domain ?? '').replace(/^www\./, '').toLowerCase();
  return Boolean(d) && (host === d || host.endsWith(`.${d}`));
}

/**
 * Builds `site:a.se OR site:b.se OR ...` to a character budget.
 *
 * Domains past the budget are dropped rather than the query being sent
 * over-length and rejected, and the caller is told how many went. A silently
 * truncated domain list looks exactly like a quiet night on those sites.
 */
export function siteClause(domains, budget = Q_MAX_CHARS) {
  const kept = [];
  let len = 0;
  for (const d of domains) {
    const piece = `site:${d}`;
    const add = kept.length ? piece.length + 4 : piece.length;
    if (len + add > budget) break;
    kept.push(piece);
    len += add;
  }
  return { clause: kept.join(' OR '), used: kept.length, dropped: domains.length - kept.length };
}

// ------------------------------------------------------------------- provider

/**
 * One Brave query. Only parameters confirmed in Brave's documentation are sent:
 * q, count, result_filter. Operators live inside q, not as separate parameters.
 *
 * NOT SENT, deliberately: freshness, country and search_lang. Brave documents
 * parameters of those names and they would plainly help a daily brief, but none
 * was verified against the live API here, and an unrecognised parameter is
 * rejected rather than ignored. Add them one at a time against the dashboard.
 */
async function braveSearch(query, { apiKey, count, timeoutMs }) {
  const url = new URL(BRAVE_ENDPOINT);
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(Math.min(count, 20)));
  url.searchParams.set('result_filter', 'web');

  const res = await fetch(url, {
    headers: {
      accept: 'application/json',
      'accept-encoding': 'gzip',
      'x-subscription-token': apiKey
    },
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!res.ok) {
    // 429 is the interesting one and must not read as "quiet night".
    throw new Error(`Brave ${res.status}${res.status === 429 ? ' (rate limit)' : ''}: ${(await res.text()).slice(0, 200)}`);
  }

  const data = await res.json();
  return (data?.web?.results ?? [])
    .map((r) => ({
      title: String(r.title ?? '').trim(),
      // Read defensively: web.results is the shape confirmed in the docs, and
      // one unexpected key should cost a field, not the call.
      url: String(r.url ?? r.link ?? '').trim(),
      snippet: String(r.description ?? r.snippet ?? '').trim()
    }))
    .filter((r) => r.url);
}

// -------------------------------------------------------------- the researcher

/**
 * Builds the researcher for one nightly run.
 *
 * Returns a function rather than a class so a sphere with retrieval switched
 * off gets something callable that returns nothing - no branch at the call
 * site, and therefore no path where a missing key changes the shape of an
 * episode.
 */
export function makeResearcher(config = {}, env = process.env) {
  const cfg = config.research ?? {};
  const R = { ...D, ...cfg, keepPerTier: { ...D.keepPerTier, ...(cfg.keepPerTier ?? {}) } };
  const apiKey = env.BRAVE_API_KEY ?? '';
  const live = R.provider === 'brave' && Boolean(apiKey);

  if (R.provider === 'brave' && !apiKey) {
    console.log('  research: provider is "brave" but BRAVE_API_KEY is unset - running without the retrieved tiers');
  }

  let lastCallAt = 0;
  let queries = 0;
  const perTier = { open: 0, analysis: 0, document: 0 };

  async function oneQuery(q, tier, keep) {
    const wait = R.minIntervalMs - (Date.now() - lastCallAt);
    if (wait > 0) await sleep(wait);
    lastCallAt = Date.now();
    queries += 1;

    const hits = await braveSearch(q, { apiKey, count: R.resultsPerQuery, timeoutMs: R.timeoutMs });
    const picked = hits.slice(0, keep).map((h) => ({ ...h, host: hostOf(h.url), tier }));
    perTier[tier] += picked.length;

    // The hosts are logged, not just the count.
    //
    // A restricted query that quietly returns general news looks identical to a
    // working one from the count alone - and "20 hits" from ten small policy
    // domains for an ordinary phrase is exactly the shape that should be
    // checked rather than trusted. Printing where the results came from is the
    // only way to see from a log whether site: is doing anything.
    const shown = picked.map((h) => h.host).join(', ') || 'nothing kept';
    console.log(`  research[${tier}]: "${q.slice(0, 64)}" -> ${hits.length} hit(s), keeping ${picked.length}: ${shown}`);
    return picked;
  }

  /**
   * Runs the tiers for one story and fetches the bodies worth reading.
   *
   * `openQuery` is the full headline - it is looking for the story. `topicQuery`
   * is a handful of terms, because a think tank does not publish under today's
   * headline, and a site-restricted search for one would return nothing every
   * single time. That distinction is the whole reason the first version found
   * zero analysis hits.
   */
  async function research({
    openQuery,
    topicQuery,
    analysisDomains = [],
    documentDomains = [],
    label = 'research'
  } = {}) {
    if (!live) return [];

    const plan = [];
    if (openQuery) plan.push({ q: openQuery, tier: 'open' });
    for (const [tier, domains] of [['analysis', analysisDomains], ['document', documentDomains]]) {
      if (!topicQuery || !domains.length) continue;
      const { clause, used, dropped } = siteClause(domains, Q_MAX_CHARS - topicQuery.length - 1);
      if (!clause) continue;
      if (dropped) console.log(`  research[${tier}]: ${dropped} domain(s) dropped at the query budget, ${used} searched`);
      plan.push({ q: `${topicQuery} ${clause}`, tier });
    }

    const out = [];
    for (const { q, tier } of plan) {
      if (q.split(/\s+/).length > Q_MAX_WORDS) {
        console.log(`  research[${tier}]: skipped, query exceeds the ${Q_MAX_WORDS}-word ceiling`);
        continue;
      }
      try {
        out.push(...await oneQuery(q, tier, R.keepPerTier[tier] ?? 2));
      } catch (e) {
        // A failed tier costs that tier for this story, never the episode.
        console.log(`  research[${tier}]: failed - ${e.message}`);
      }
    }

    // The same page can answer an open query and a restricted one. Kept once,
    // under the tier that found it first.
    const seen = new Set();
    const unique = out.filter((h) => !seen.has(h.url) && seen.add(h.url));

    // Bodies only for the ones that will be read - a snippet is a teaser, and
    // the point of this layer is to have read something the coverage did not.
    // Document tier goes first: a proposition read in full is worth more than a
    // column read in full.
    const order = { document: 0, analysis: 1, open: 2 };
    const ranked = [...unique].sort((a, b) => order[a.tier] - order[b.tier]);

    const withBodies = [];
    for (const [i, h] of ranked.entries()) {
      const body = i < R.fetchBodies ? await fetchArticleText(h.url, { maxChars: R.bodyMaxChars }) : null;
      withBodies.push({ ...h, body });
    }
    console.log(`  ${label}: full text for ${withBodies.filter((h) => h.body).length}/${Math.min(ranked.length, R.fetchBodies)} retrieved source(s)`);
    return withBodies;
  }

  research.live = live;
  research.stats = () => ({ provider: R.provider, live, queries, perTier });
  return research;
}
