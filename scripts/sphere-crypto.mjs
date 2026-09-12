/**
 * Crypto sphere. Unlike Congress there is no single authoritative source of
 * "what happened" - so this module links coverage to one of two primary-source
 * kinds: a governance forum proposal (Discourse JSON API, no key) or a sized
 * on-chain move (DefiLlama, no key). Whichever kind, the model never invents a
 * number or a vote count - it only ever restates what fetchPrimarySource pulled.
 */

import { strip } from './lib.mjs';

async function discourseTopic(base, topicId) {
  const res = await fetch(`${base}/t/${topicId}.json`, {
    headers: { 'user-agent': 'morgonbrief/0.1' },
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`Discourse ${res.status} on ${base}/t/${topicId}`);
  return res.json();
}

async function discourseLatest(base) {
  const res = await fetch(`${base}/latest.json`, {
    headers: { 'user-agent': 'morgonbrief/0.1' },
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`Discourse ${res.status} on ${base}/latest.json`);
  return res.json();
}

async function defillamaTvl(chain) {
  const res = await fetch(`https://api.llama.fi/v2/historicalChainTvl/${encodeURIComponent(chain)}`, {
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`DefiLlama ${res.status} on ${chain}`);
  const series = await res.json();
  return series.slice(-2); // [yesterday, today] - enough to size a 24h move
}

/**
 * Fetches each forum's recent-topics list once up front so linkCoverage can
 * match headlines against real topic titles instead of guessing an ID.
 */
export async function loadGovernanceIndex(sphere) {
  const results = await Promise.allSettled(
    sphere.governanceForums.map(async (f) => ({ forum: f, data: await discourseLatest(f.base) }))
  );
  const index = [];
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const t of r.value.data.topic_list?.topics ?? []) {
      index.push({ forum: r.value.forum.name, base: r.value.forum.base, id: t.id, title: t.title, postsCount: t.posts_count, createdAt: t.created_at });
    }
  }
  const failed = results.filter((r) => r.status === 'rejected').length;
  console.log(`Governance index: ${index.length} topics from ${sphere.governanceForums.length - failed}/${sphere.governanceForums.length} forums`);
  return index;
}

export async function linkCoverage(items, { deepseek, today, governanceIndex, sphere }) {
  if (!items.length) return [];
  const newsDigest = items
    .slice(0, 120)
    .map((it, i) => `${i}. [${it.source}] ${it.title} :: ${it.summary.slice(0, 180)}`)
    .join('\n');
  const forumDigest = governanceIndex
    .slice(0, 150)
    .map((t, i) => `F${i}. [${t.forum}] ${t.title} (${t.postsCount} posts)`)
    .join('\n');

  const out = await deepseek(
    [
      {
        role: 'system',
        content:
          'You match crypto news coverage to one of two primary-source kinds: a governance forum topic, ' +
          'or a chain/protocol whose on-chain numbers likely moved because of what the coverage describes. ' +
          'You never guess a number. Return strict JSON only.'
      },
      {
        role: 'user',
        content:
          `Today is ${today}.\n\nNews headlines:\n${newsDigest}\n\n` +
          `Governance forum topics (index Fn):\n${forumDigest}\n\n` +
          `Chains this sphere tracks: ${sphere.defillamaChains.join(', ')}\n\n` +
          'Return JSON of the shape:\n' +
          '{"matches":[' +
          '{"kind":"governance","itemIndexes":[0,3],"forumIndex":12,"whyCovered":"one sentence"},' +
          '{"kind":"tvl","itemIndexes":[5],"chain":"Solana","whyCovered":"one sentence"}' +
          ']}\n\n' +
          'kind "governance" requires a real Fn index from the list above - never invent a topic. ' +
          'kind "tvl" requires a chain from the tracked list, used only when the coverage describes something ' +
          'that plausibly moved that chain\'s total value locked (an exploit, a large withdrawal, a depeg, a major launch). ' +
          'Group every headline about the same thing into one match. Omit anything that fits neither kind. ' +
          'An empty list is a valid and common answer.'
      }
    ],
    { json: true, maxTokens: 1800 }
  );

  const matches = Array.isArray(out.matches) ? out.matches : [];
  console.log(`Linked ${matches.length} crypto candidate(s)`);
  return matches.map((m) => ({ ...m, coverage: (m.itemIndexes ?? []).map((i) => items[i]).filter(Boolean) }));
}

export async function fetchPrimarySource(match, { governanceIndex }) {
  if (match.kind === 'governance') return fetchGovernanceSource(match, governanceIndex);
  if (match.kind === 'tvl') {
    const points = await defillamaTvl(match.chain);
    if (points.length < 2) throw new Error(`Not enough TVL history for ${match.chain}`);
    const [prev, cur] = points;
    const pct = ((cur.tvl - prev.tvl) / prev.tvl) * 100;
    return {
      ...match,
      id: `tvl-${match.chain.toLowerCase()}-${new Date(cur.date * 1000).toISOString().slice(0, 10)}`,
      title: `${match.chain}: TVL-rörelse`,
      chain: match.chain,
      tvlPrevUSD: prev.tvl,
      tvlNowUSD: cur.tvl,
      tvlChangePct: pct,
      url: `https://defillama.com/chain/${match.chain}`
    };
  }
  throw new Error(`Unknown match kind: ${match.kind}`);
}

async function fetchGovernanceSource(match, governanceIndex) {
  const ref = governanceIndex[match.forumIndex];
  if (!ref) throw new Error(`No governance topic at index ${match.forumIndex}`);
  const topic = await discourseTopic(ref.base, ref.id);
  const posts = (topic.post_stream?.posts ?? []).slice(0, 20);
  return {
    ...match,
    id: `gov-${ref.forum.toLowerCase().replace(/\s+/g, '-')}-${ref.id}`,
    title: topic.title ?? ref.title,
    forum: ref.forum,
    url: `${ref.base}/t/${topic.slug ?? ''}/${ref.id}`,
    postsCount: topic.posts_count ?? ref.postsCount,
    createdAt: topic.created_at,
    excerpt: strip(posts[0]?.cooked ?? '').slice(0, 2000),
    replySummaries: posts.slice(1, 8).map((p) => strip(p.cooked).slice(0, 400))
  };
}

export function score(doc, sphere) {
  const w = sphere.scoring;
  const reasons = [];
  let total = 0;
  const add = (points, why) => { total += points; reasons.push(`${why} (+${points})`); };

  if (doc.kind === 'governance') {
    if (doc.postsCount >= 30) add(w.governanceVotePassedContested, `Contested (${doc.postsCount} replies)`);
    else if (doc.postsCount >= 8) add(w.governanceVoteLive, `Live discussion (${doc.postsCount} replies)`);
  }

  if (doc.kind === 'tvl') {
    const abs = Math.abs(doc.tvlChangePct);
    if (abs >= sphere.tvlMoveThresholds.extremePct) add(w.tvlMoveExtreme, `Extreme TVL move (${doc.tvlChangePct.toFixed(1)}%)`);
    else if (abs >= sphere.tvlMoveThresholds.largePct) add(w.tvlMoveLarge, `Large TVL move (${doc.tvlChangePct.toFixed(1)}%)`);
    const deltaUSD = Math.abs(doc.tvlNowUSD - doc.tvlPrevUSD);
    if (deltaUSD >= sphere.moneyThresholdUSD) add(w.moneyThresholdUSD, `>$${(sphere.moneyThresholdUSD / 1e6).toFixed(0)}M moved`);
  }

  if (doc.coverage.length >= 3) add(w.multipleIndependentSources, `${doc.coverage.length} independent sources`);

  return { ...doc, score: total, reasons, qualifies: total >= w.threshold };
}

export async function writeCards(docs, { deepseek }) {
  if (!docs.length) return [];
  return deepseek(
    [
      {
        role: 'system',
        content:
          'You write short Swedish briefing entries about crypto for a reader who already follows the news. ' +
          'Use only the supplied material. Never state a figure that is not in the material. This is not ' +
          'investment advice - never phrase anything as a recommendation. Strict JSON only.'
      },
      {
        role: 'user',
        content:
          `Material:\n${JSON.stringify(docs, null, 1)}\n\n` +
          'Return {"cards":[{"id":"...","rubrik":"...","sammanfattning":"2-3 sentences on what the primary ' +
          'source actually shows","varfor":"1-2 sentences on why it matters","status":"one clause on where ' +
          'this stands right now"}]} All values in Swedish.'
      }
    ],
    { json: true, maxTokens: 2500 }
  ).then((r) => (Array.isArray(r.cards) ? r.cards : []));
}

export async function writeScript(docs, sphere, { deepseek, today }) {
  if (!docs.length) {
    return (
      'God morgon. Inget i crypto klarade tröskeln idag. Ingen governance-strid var het nog, ' +
      'och inga kedjor rörde sig utanför det normala. Vi hörs imorgon.'
    );
  }

  return deepseek([
    {
      role: 'system',
      content:
        'You write a spoken Swedish briefing segment. Rules you must follow exactly:\n' +
        sphere.scriptRules.map((r, i) => `${i + 1}. ${r}`).join('\n')
    },
    {
      role: 'user',
      content:
        `Date: ${today}.\n\nMaterial (this is your only permitted source of fact):\n${JSON.stringify(docs, null, 1)}\n\n` +
        'Write the full spoken script. Open by naming what the listener has already seen in the coverage, ' +
        'in one sentence, then go straight past it into the primary source - the forum thread or the chain\'s ' +
        'own numbers. Close by saying plainly which claims rest on a single source. Plain text only.'
    }
  ], { maxTokens: 6000 });
}

export function cardFromDoc(d, card) {
  return {
    id: d.id,
    rubrik: card.rubrik ?? d.title,
    sammanfattning: card.sammanfattning ?? '',
    varfor: card.varfor ?? '',
    status: card.status ?? '',
    score: d.score,
    reasons: d.reasons,
    singleSource: d.coverage.length < 2,
    documentUrl: d.url,
    coverage: d.coverage.slice(0, 5).map((c) => ({ source: c.source, title: c.title, link: c.link }))
  };
}
