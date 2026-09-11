/**
 * Morgonbrief - daily pipeline.
 *
 * Order of operations, and why:
 *   1. Media sweep decides WHAT gets covered. If the coverage ignored it, we ignore it.
 *   2. Congress.gov decides WHAT WE SAY about it. The documents are the only source of depth.
 *   3. Scoring is arithmetic, never a model judgement.
 *   4. The model writes prose from material already in context. It never recalls facts.
 *
 * Outputs: out/feed.json, out/pod-YYYY-MM-DD.mp3, plus a Firestore document.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { XMLParser } from 'fast-xml-parser';
import { GoogleAuth } from 'google-auth-library';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

// ---------------------------------------------------------------- config

const DEEPSEEK_KEY = req('DEEPSEEK_API_KEY');
const CONGRESS_KEY = req('CONGRESS_API_KEY');
const SA = JSON.parse(req('GCP_SERVICE_ACCOUNT'));
const REPO = process.env.GITHUB_REPOSITORY || 'unknown/morgonbrief';

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const DEEPSEEK_MODEL = 'deepseek-flash';
const AUDIO_TAG = 'audio'; // GitHub release tag that holds every episode

const today = new Date().toISOString().slice(0, 10);

function req(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required secret: ${name}`);
  return v;
}

// ---------------------------------------------------------------- helpers

async function deepseek(messages, { json = false, maxTokens = 4000 } = {}) {
  const res = await fetch(DEEPSEEK_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${DEEPSEEK_KEY}`
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages,
      max_tokens: maxTokens,
      temperature: json ? 0 : 0.6,
      ...(json ? { response_format: { type: 'json_object' } } : {})
    })
  });
  if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content ?? '';
  if (!json) return text;
  try {
    return JSON.parse(text.replace(/^```json\s*|\s*```$/g, '').trim());
  } catch {
    throw new Error(`DeepSeek returned unparseable JSON: ${text.slice(0, 400)}`);
  }
}

async function congress(path, params = {}) {
  const url = new URL(`https://api.congress.gov/v3/${path}`);
  url.searchParams.set('format', 'json');
  url.searchParams.set('api_key', CONGRESS_KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Congress.gov ${res.status} on ${path}`);
  return res.json();
}

const strip = (s) =>
  String(s ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// ---------------------------------------------------- 1. media sweep

async function sweepMedia(sphere) {
  const parser = new XMLParser({ ignoreAttributes: false });
  const cutoff = Date.now() - 36 * 3600 * 1000;
  const items = [];

  const results = await Promise.allSettled(
    sphere.feeds.map(async (url) => {
      const res = await fetch(url, {
        headers: { 'user-agent': 'morgonbrief/0.1' },
        signal: AbortSignal.timeout(20000)
      });
      if (!res.ok) throw new Error(`${res.status}`);
      return { url, xml: parser.parse(await res.text()) };
    })
  );

  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    const feed = r.value.xml?.rss?.channel ?? r.value.xml?.feed ?? {};
    const source = strip(feed.title) || new URL(r.value.url).hostname;
    const entries = [].concat(feed.item ?? feed.entry ?? []);
    for (const e of entries) {
      const when = Date.parse(e.pubDate ?? e.published ?? e.updated ?? '') || Date.now();
      if (when < cutoff) continue;
      items.push({
        source,
        title: strip(e.title),
        summary: strip(e.description ?? e.summary ?? '').slice(0, 500),
        link: typeof e.link === 'string' ? e.link : e.link?.['@_href'] ?? ''
      });
    }
  }

  const failed = results.filter((r) => r.status === 'rejected').length;
  console.log(`Sweep: ${items.length} items from ${sphere.feeds.length - failed}/${sphere.feeds.length} feeds`);
  return items;
}

// -------------------------------------- 2. link coverage to legislation

async function linkToLegislation(items) {
  if (!items.length) return [];
  const digest = items
    .slice(0, 120)
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
    { json: true, maxTokens: 1500 }
  );

  const matches = Array.isArray(out.matches) ? out.matches : [];
  console.log(`Linked ${matches.length} legislative candidate(s)`);
  return matches.map((m) => ({
    ...m,
    coverage: (m.itemIndexes ?? []).map((i) => items[i]).filter(Boolean)
  }));
}

// ------------------------------------------- 3. fetch primary documents

async function fetchDocuments(match) {
  const { congress: c, billType, billNumber } = match;
  const base = `bill/${c}/${String(billType).toLowerCase()}/${billNumber}`;

  const [detail, actions, cosponsors, summaries] = await Promise.all([
    congress(base),
    congress(`${base}/actions`, { limit: 25 }),
    congress(`${base}/cosponsors`, { limit: 250 }),
    congress(`${base}/summaries`).catch(() => ({ summaries: [] }))
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
    actions: (actions.actions ?? []).map((a) => ({
      date: a.actionDate,
      text: a.text,
      type: a.type ?? ''
    })),
    cosponsors: (cosponsors.cosponsors ?? []).map((p) => ({
      party: p.party,
      state: p.state,
      name: p.fullName
    })),
    summary: strip(summaries.summaries?.at(-1)?.text ?? '').slice(0, 4000)
  };
}

function billTypeSlug(t) {
  return {
    hr: 'house-bill', s: 'senate-bill',
    hjres: 'house-joint-resolution', sjres: 'senate-joint-resolution',
    hconres: 'house-concurrent-resolution', sconres: 'senate-concurrent-resolution',
    hres: 'house-resolution', sres: 'senate-resolution'
  }[String(t).toLowerCase()] ?? 'house-bill';
}

// ------------------------------------------------ 4. deterministic score

function score(doc, sphere) {
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
  if (last && Date.now() - Date.parse(last) < 48 * 3600 * 1000) {
    add(w.actionWithin48h, 'Moved in the last 48h');
  }

  return { ...doc, score: total, reasons, qualifies: total >= w.threshold };
}

// ----------------------------------------------------- 5. written cards

async function writeCards(docs) {
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
    { json: true, maxTokens: 2500 }
  ).then((r) => (Array.isArray(r.cards) ? r.cards : []));
}

// -------------------------------------------------- 6. podcast script

async function writeScript(docs, sphere) {
  if (!docs.length) {
    return (
      'God morgon. Inget lagförslag klarade tröskeln idag. Bevakningen handlade om politik, ' +
      'inte om lagstiftning som rört sig, och då finns det ingenting i dokumenten att fördjupa. ' +
      'Vi hörs imorgon.'
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
        '\n\nWrite the full spoken script. Open by naming what the listener has already seen in ' +
        'the coverage, in one sentence, then go straight past it into the documents. ' +
        'Close by saying plainly which claims rest on a single source. Plain text only.'
    }
  ], { maxTokens: 6000 });
}

// --------------------------------------------------------- 7. synthesis

async function synthesize(script) {
  const auth = new GoogleAuth({
    credentials: SA,
    scopes: ['https://www.googleapis.com/auth/cloud-platform']
  });
  const client = await auth.getClient();
  const token = (await client.getAccessToken()).token;
  const H = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  // Pick the best Swedish voice this project actually has, rather than hardcoding a
  // name that may not exist. Chirp3-HD sounds best but does not accept SSML, so we
  // only ever send plain text.
  const list = await fetch('https://texttospeech.googleapis.com/v1/voices?languageCode=sv-SE', { headers: H });
  if (!list.ok) throw new Error(`TTS voices ${list.status}: ${await list.text()}`);
  const voices = (await list.json()).voices ?? [];
  const pick =
    voices.find((v) => v.name.includes('Chirp3-HD')) ??
    voices.find((v) => v.name.includes('Wavenet')) ??
    voices.find((v) => v.name.includes('Neural2')) ??
    voices[0];
  if (!pick) throw new Error('No Swedish voice available in this project');
  console.log(`Voice: ${pick.name}`);

  // The API caps input per request, so split on sentence boundaries and concatenate
  // the resulting MP3 frames.
  const chunks = [];
  let buf = '';
  for (const sentence of script.split(/(?<=[.!?])\s+/)) {
    if ((buf + sentence).length > 4200) { chunks.push(buf.trim()); buf = ''; }
    buf += sentence + ' ';
  }
  if (buf.trim()) chunks.push(buf.trim());

  const parts = [];
  for (const [i, text] of chunks.entries()) {
    const res = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize', {
      method: 'POST',
      headers: H,
      body: JSON.stringify({
        input: { text },
        voice: { languageCode: 'sv-SE', name: pick.name },
        audioConfig: { audioEncoding: 'MP3' }
      })
    });
    if (!res.ok) throw new Error(`TTS synth ${res.status}: ${await res.text()}`);
    parts.push(Buffer.from((await res.json()).audioContent, 'base64'));
    console.log(`  synthesised chunk ${i + 1}/${chunks.length}`);
  }
  return Buffer.concat(parts);
}

// ------------------------------------------------------------ 8. publish

async function main() {
  const sphere = JSON.parse(await readFile(new URL('../spheres/congress.json', import.meta.url), 'utf8'));

  initializeApp({ credential: cert(SA) });
  const db = getFirestore();

  const seenSnap = await db.doc('state/seen').get();
  const seen = new Set(seenSnap.exists ? seenSnap.data().billIds ?? [] : []);

  const coverage = await sweepMedia(sphere);
  const candidates = await linkToLegislation(coverage);

  const scored = [];
  for (const c of candidates) {
    try {
      const doc = await fetchDocuments(c);
      if (seen.has(doc.id)) { console.log(`skip (already covered): ${doc.id}`); continue; }
      scored.push(score(doc, sphere));
    } catch (e) {
      console.log(`skip (${c.billType}${c.billNumber}): ${e.message}`);
    }
  }

  const chosen = scored
    .filter((d) => d.qualifies)
    .sort((a, b) => b.score - a.score)
    .slice(0, sphere.maxItemsPerEpisode);

  console.log(`Scored ${scored.length}, qualified ${chosen.length}`);
  for (const d of chosen) console.log(`  ${d.score} ${d.id} :: ${d.reasons.join(', ')}`);

  const [cards, script] = await Promise.all([writeCards(chosen), writeScript(chosen, sphere)]);
  const audio = await synthesize(script);

  const file = `pod-${today}.mp3`;
  await mkdir(new URL('../out/', import.meta.url), { recursive: true });
  await writeFile(new URL(`../out/${file}`, import.meta.url), audio);

  // Release asset URLs are deterministic, so we can store the link before upload.
  const audioUrl = `https://github.com/${REPO}/releases/download/${AUDIO_TAG}/${file}`;

  const brief = {
    date: today,
    sphere: sphere.id,
    audioUrl,
    audioBytes: audio.length,
    itemCount: chosen.length,
    items: chosen.map((d) => {
      const card = cards.find((c) => c.id === d.id) ?? {};
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
    }),
    script,
    createdAt: FieldValue.serverTimestamp()
  };

  await db.doc(`briefs/${today}`).set(brief);
  await db.doc('state/seen').set(
    { billIds: [...seen, ...chosen.map((d) => d.id)].slice(-500) },
    { merge: true }
  );
  await writeFile(
    new URL('../out/feed.json', import.meta.url),
    JSON.stringify({ ...brief, createdAt: new Date().toISOString() }, null, 2)
  );

  console.log(`Done: ${chosen.length} item(s), ${(audio.length / 1e6).toFixed(1)} MB audio`);
}

main().catch((e) => { console.error(e); process.exit(1); });
