/**
 * Congress sphere. Media sweep decides WHAT (see run.mjs); this module decides
 * WHAT WE SAY, by linking coverage to a specific bill and pulling that bill's
 * own text, actions and cosponsor list from Congress.gov.
 */

import { strip, scriptSystemPrompt } from './lib.mjs';

async function congressApi(path, params, apiKey) {
  const url = new URL(`https://api.congress.gov/v3/${path}`);
  url.searchParams.set('format', 'json');
  url.searchParams.set('api_key', apiKey);
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Congress.gov ${res.status} on ${path}`);
  return res.json();
}

function billTypeSlug(t) {
  return {
    hr: 'house-bill', s: 'senate-bill',
    hjres: 'house-joint-resolution', sjres: 'senate-joint-resolution',
    hconres: 'house-concurrent-resolution', sconres: 'senate-concurrent-resolution',
    hres: 'house-resolution', sres: 'senate-resolution'
  }[String(t).toLowerCase()] ?? 'house-bill';
}

export async function linkCoverage(items, { deepseek, today, limits = {} }) {
  if (!items.length) return [];
  const digest = items
    .slice(0, limits.maxCoverageItems ?? 400)
    .map((it, i) => `${i}. [${it.source}] ${it.title} :: ${it.summary.slice(0, 180)}`)
    .join('\n');

  const out = await deepseek(
    [
      {
        role: 'system',
        content:
          'You map news coverage to concrete US federal legislation. You never guess. ' +
          'A bill identifier is only valid if the coverage itself names or unambiguously describes a specific bill, ' +
          'resolution or recorded vote. General political news with no specific legislative vehicle is not a match. ' +
          'Return strict JSON only.'
      },
      {
        role: 'user',
        content:
          `Today is ${today}. Current Congress is the 119th.\n\n` +
          `Headlines:\n${digest}\n\n` +
          'Return JSON of the shape:\n' +
          '{"matches":[{"itemIndexes":[0,4],"congress":119,"billType":"hr","billNumber":"1234",' +
          '"whyCovered":"one sentence, in English, on what the coverage is about"}]}\n\n' +
          'billType is one of hr, s, hjres, sjres, hconres, sconres, hres, sres. ' +
          'Group every headline about the same bill into one match. ' +
          'Omit anything you cannot tie to a specific bill number. An empty list is a valid and common answer.'
      }
    ],
    { json: true, maxTokens: limits.tokensLinking ?? 16000, role: 'congress-linking' }
  );

  const matches = Array.isArray(out.matches) ? out.matches : [];
  console.log(`Linked ${matches.length} legislative candidate(s)`);
  return matches.map((m) => ({ ...m, coverage: (m.itemIndexes ?? []).map((i) => items[i]).filter(Boolean) }));
}

export async function fetchPrimarySource(match, { apiKey }) {
  const { congress: c, billType, billNumber } = match;
  const base = `bill/${c}/${String(billType).toLowerCase()}/${billNumber}`;

  const [detail, actions, cosponsors, summaries] = await Promise.all([
    congressApi(base, {}, apiKey),
    congressApi(`${base}/actions`, { limit: 25 }, apiKey),
    congressApi(`${base}/cosponsors`, { limit: 250 }, apiKey),
    congressApi(`${base}/summaries`, {}, apiKey).catch(() => ({ summaries: [] }))
  ]);

  const bill = detail.bill ?? {};
  return {
    ...match,
    id: `${c}-${billType}-${billNumber}`.toLowerCase(),
    title: bill.title ?? '',
    sponsor: bill.sponsors?.[0] ?? null,
    policyArea: bill.policyArea?.name ?? '',
    latestAction: bill.latestAction ?? null,
    url: `https://www.congress.gov/bill/${c}th-congress/${billTypeSlug(billType)}/${billNumber}`,
    actions: (actions.actions ?? []).map((a) => ({ date: a.actionDate, text: a.text, type: a.type ?? '' })),
    cosponsors: (cosponsors.cosponsors ?? []).map((p) => ({ party: p.party, state: p.state, name: p.fullName })),
    summary: strip(summaries.summaries?.at(-1)?.text ?? '').slice(0, 4000)
  };
}

export function score(doc, sphere) {
  const w = sphere.scoring;
  const reasons = [];
  let total = 0;
  const add = (points, why) => { total += points; reasons.push(`${why} (+${points})`); };

  const actionText = doc.actions.map((a) => a.text.toLowerCase()).join(' | ');
  const haystack = `${doc.title} ${doc.summary}`.toLowerCase();

  if (/passed\/agreed to in (house|senate)|passed (house|senate)/.test(actionText)) {
    add(w.passedOneChamber, 'Passed a chamber');
  }
  if (/reported (by|to)|ordered to be reported|placed on the union calendar/.test(actionText)) {
    add(w.reportedOutOfCommittee, 'Out of committee');
  }

  const dem = doc.cosponsors.filter((p) => p.party === 'D').length;
  const rep = doc.cosponsors.filter((p) => p.party === 'R').length;
  if (dem >= 5 && rep >= 5) add(w.bipartisanCosponsors, `Bipartisan (${rep}R / ${dem}D)`);
  if (doc.cosponsors.length >= 40) add(w.manyCosponsors, `${doc.cosponsors.length} cosponsors`);

  const hit = sphere.moneyOrDeadlineTerms.find((t) => haystack.includes(t));
  if (hit) add(w.moneyOrDeadline, `Money or deadline ("${hit}")`);

  const last = doc.actions[0]?.date ?? doc.latestAction?.actionDate;
  if (last && Date.now() - Date.parse(last) < 48 * 3600 * 1000) add(w.actionWithin48h, 'Moved in the last 48h');

  return { ...doc, score: total, reasons, qualifies: total >= w.threshold };
}

export async function writeCards(docs, { deepseek, limits = {} }) {
  if (!docs.length) return [];
  return deepseek(
    [
      {
        role: 'system',
        content:
          'You write short Swedish briefing entries for a reader who already follows the news closely ' +
          'but is not an expert on US legislative procedure. Use only the supplied material. ' +
          'Rewrite in your own words - never reproduce article or document wording. Strict JSON only.'
      },
      {
        role: 'user',
        content:
          `Material:\n${JSON.stringify(
            docs.map((d) => ({
              id: d.id,
              title: d.title,
              sponsor: d.sponsor?.fullName,
              cosponsors: `${d.cosponsors.filter((p) => p.party === 'R').length}R / ${d.cosponsors.filter((p) => p.party === 'D').length}D`,
              latestAction: d.latestAction,
              recentActions: d.actions.slice(0, 8),
              officialSummary: d.summary,
              whyCovered: d.whyCovered,
              coverage: d.coverage.map((c) => ({ source: c.source, title: c.title }))
            })),
            null,
            1
          )}\n\n` +
          'Return {"cards":[{"id":"...","rubrik":"...","sammanfattning":"2-3 sentences on what the document actually says",' +
          '"varfor":"1-2 sentences on why it matters","status":"where it stands right now, one clause"}]} ' +
          'All values in Swedish. Explain any procedural term inside the sentence it appears in.'
      }
    ],
    { json: true, maxTokens: limits.tokensCards ?? 16000, role: 'congress-cards' }
  ).then((r) => (Array.isArray(r.cards) ? r.cards : []));
}

export async function writeScript(docs, sphere, { deepseek, today, config = {} }) {
  if (!docs.length) {
    return (
      'God morgon. Inget lagförslag klarade tröskeln idag. Bevakningen handlade om politik, ' +
      'inte om lagstiftning som rört sig, och då finns det ingenting i dokumenten att fördjupa. ' +
      'Vi hörs imorgon.'
    );
  }

  return deepseek([
    { role: 'system', content: scriptSystemPrompt(sphere, config) },
    {
      role: 'user',
      content:
        `Date: ${today}.\n\nMaterial (this is your only permitted source of fact):\n` +
        JSON.stringify(
          docs.map((d) => ({
            title: d.title,
            congressUrl: d.url,
            sponsor: d.sponsor,
            cosponsorBreakdown: {
              R: d.cosponsors.filter((p) => p.party === 'R').length,
              D: d.cosponsors.filter((p) => p.party === 'D').length,
              sample: d.cosponsors.slice(0, 12)
            },
            actionHistory: d.actions,
            officialSummary: d.summary,
            whyCovered: d.whyCovered,
            coverage: d.coverage.map((c) => ({ source: c.source, title: c.title, summary: c.summary }))
          })),
          null,
          1
        ) +
        '\n\nWrite the full spoken script. If there is more than one subject, each gets its own complete ANNOUNCE / GROUND / SUBSTANCE segment, and you move between them with a plain handover that names the next subject - never a linking sentence that implies the two are connected. ' +
        'Within SUBSTANCE, go past what the headlines already said and into what the documents show. ' +
        'Close the episode by saying plainly which claims rest on a single source. Plain text only.'
    }
  ], { maxTokens: config.limits?.tokensScript ?? 16000, role: 'congress-script' });
}

export function cardFromDoc(d, card) {
  return {
    id: d.id,
    rubrik: card.rubrik ?? d.title,
    sammanfattning: card.sammanfattning ?? '',
    varfor: card.varfor ?? '',
    status: card.status ?? strip(d.latestAction?.text ?? ''),
    score: d.score,
    reasons: d.reasons,
    singleSource: d.coverage.length < 2,
    documentUrl: d.url,
    coverage: d.coverage.slice(0, 5).map((c) => ({ source: c.source, title: c.title, link: c.link }))
  };
}
