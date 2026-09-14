/**
 * research.mjs - the independent retrieval layer.
 *
 * Every other input to this pipeline arrives because an RSS feed pushed it.
 * That is a closed loop: the sphere can only ever discuss what its own feed
 * list already surfaced, and it cannot say anything the coverage did not say
 * first. This module is the one place that reaches outside that loop - it runs
 * a query the pipeline formed itself and fetches what comes back.
 *
 * WHY THAT NEEDS ITS OWN PROVENANCE TIER. Material from here was not asserted
 * by an outlet covering the story. It is the pipeline's own reading, assembled
 * from sources nobody in the cluster cited. Presenting that beside reported
 * facts without a label would quietly upgrade it, so everything this module
 * returns is tagged `tolkning` and must stay tagged all the way to the script.
 * See sphere-sverige.mjs, which refuses to let the model mix the two.
 *
 * PROVIDER. Brave Web Search. Verified against Brave's own documentation
 * (api-dashboard.search.brave.com/docs): endpoint, the three headers, and the
 * web.results response shape.
 *
 * Google's Custom Search JSON API was the obvious alternative because the
 * project already holds GCP credentials. It is ruled out on Google's own
 * documentation: the API is closed to new customers and is discontinued on
 * 1 January 2027. Building the analysis tier of a daily brief on an endpoint
 * with a published end-of-life fifteen months out is not worth the saved
 * secret.
 *
 * DEGRADES TO NOTHING. No key, provider 'none', a 4xx, a timeout - every path
 * returns an empty array. The sphere then publishes with three provenance
 * tiers instead of four and says so. Retrieval is the layer that makes the
 * episode better; it is never the layer that decides whether there is one.
 */

import { fetchArticleText, BROWSER_UA } from './lib.mjs';

const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';

const D = {
  provider: 'none',
  resultsPerQuery: 20,
  keepAnalysis: 4,
  keepOther: 2,
  fetchBodies: 3,
  bodyMaxChars: 12000,
  // Brave's free tier is documented at one request per second. Serialised with
  // headroom rather than fired in parallel: a 429 here costs the whole tier for
  // the night, and the nightly run has hours of budget to spare.
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
 * `includes()` would match kvartal.se inside notkvartal.se.example, which is
 * exactly the sort of thing that puts an unrelated page under an analysis
 * label.
 */
export function matchesDomain(host, domain) {
  const d = String(domain ?? '').replace(/^www\./, '').toLowerCase();
  return Boolean(d) && (host === d || host.endsWith(`.${d}`));
}

// ------------------------------------------------------------------- provider

/**
 * One Brave query. Only the three parameters confirmed in Brave's
 * documentation are sent: q, count, result_filter.
 *
 * NOT SENT, deliberately: `freshness`, `country` and `search_lang`. Brave
 * documents parameters of those names and they would plainly help a daily news
 * brief, but none was verified against the live API here, and an unrecognised
 * parameter is rejected rather than ignored. Add them one at a time against the
 * dashboard's request builder, not from memory.
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
    // 429 is the interesting one and must not read as "quiet night". Named here
    // so the log says rate limit rather than zero results.
    throw new Error(`Brave ${res.status}${res.status === 429 ? ' (rate limit)' : ''}: ${(await res.text()).slice(0, 200)}`);
  }

  const data = await res.json();
  const results = data?.web?.results ?? [];
  return results
    .map((r) => ({
      title: String(r.title ?? '').trim(),
      // Field names read defensively: the shape confirmed in the docs is
      // web.results, and one unexpected key should cost a field, not the call.
      url: String(r.url ?? r.link ?? '').trim(),
      snippet: String(r.description ?? r.snippet ?? '').trim()
    }))
    .filter((r) => r.url);
}

// --------------------------------------------------------------- the researcher

/**
 * Builds the researcher used for one nightly run.
 *
 * Returns a function, not a class, so that a sphere with retrieval switched off
 * gets something callable that returns nothing - no branch at the call site,
 * and therefore no path where a missing key changes the shape of the episode.
 */
export function makeResearcher(config = {}, env = process.env) {
  const R = { ...D, ...(config.research ?? {}) };
  const apiKey = env.BRAVE_API_KEY ?? '';
  const live = R.provider === 'brave' && Boolean(apiKey);

  if (R.provider === 'brave' && !apiKey) {
    console.log('  research: provider is "brave" but BRAVE_API_KEY is unset - running without the tolkning tier');
  }

  let lastCallAt = 0;
  let queries = 0;

  /**
   * One query, then the bodies of the best results.
   *
   * `domains` is the analysis list. Results are partitioned against it rather
   * than restricted with a site: operator in the query string: the operator was
   * not verified against Brave, and a silently unsupported operator returns a
   * plausible page of the wrong thing. Partitioning client-side cannot fail
   * that way, and one query serves both halves.
   */
  async function research(query, { domains = [], label = '  research' } = {}) {
    if (!live || !query) return [];

    try {
      const wait = R.minIntervalMs - (Date.now() - lastCallAt);
      if (wait > 0) await sleep(wait);
      lastCallAt = Date.now();
      queries += 1;

      const hits = await braveSearch(query, {
        apiKey,
        count: R.resultsPerQuery,
        timeoutMs: R.timeoutMs
      });

      const analysis = [];
      const other = [];
      for (const h of hits) {
        const host = hostOf(h.url);
        (domains.some((d) => matchesDomain(host, d)) ? analysis : other).push({ ...h, host });
      }

      const picked = [
        ...analysis.slice(0, R.keepAnalysis).map((h) => ({ ...h, tier: 'analysis' })),
        ...other.slice(0, R.keepOther).map((h) => ({ ...h, tier: 'open' }))
      ];

      console.log(`${label}: "${query.slice(0, 70)}" -> ${hits.length} hit(s), ${analysis.length} on the analysis list, keeping ${picked.length}`);

      // Bodies only for the ones that will actually be read. A snippet is a
      // teaser, and the whole point of this tier is to have read something the
      // coverage did not.
      const withBodies = [];
      for (const [i, h] of picked.entries()) {
        const body = i < R.fetchBodies
          ? await fetchArticleText(h.url, { maxChars: R.bodyMaxChars })
          : null;
        withBodies.push({ ...h, body });
      }

      const fetched = withBodies.filter((h) => h.body).length;
      console.log(`${label}: full text for ${fetched}/${Math.min(picked.length, R.fetchBodies)} fetched`);
      return withBodies;
    } catch (e) {
      // Never throws upward. A failed search costs the tolkning tier for one
      // cluster; a thrown error would cost the episode.
      console.log(`${label}: failed - ${e.message}`);
      return [];
    }
  }

  research.live = live;
  research.stats = () => ({ provider: R.provider, live, queries });
  return research;
}

export { BROWSER_UA };
