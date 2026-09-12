/**
 * Shared primitives every sphere module uses. Nothing sphere-specific lives here -
 * a sphere is "media sweep decides WHAT, primary source decides WHAT WE SAY, scoring
 * is arithmetic, the model only writes from material already in context." This file
 * is the plumbing that discipline runs on top of.
 */

import { XMLParser } from 'fast-xml-parser';
import { GoogleAuth } from 'google-auth-library';

export const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
export const DEEPSEEK_MODEL = 'deepseek-flash';

export function req(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required secret: ${name}`);
  return v;
}

export const strip = (s) =>
  String(s ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export function makeDeepseek(apiKey) {
  return async function deepseek(messages, { json = false, maxTokens = 4000 } = {}) {
    const res = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages,
        max_tokens: maxTokens,
        temperature: json ? 0 : 0.6,
        // V4-family models think by default now (see api-docs.deepseek.com/guides/thinking_mode).
        // The reasoning tokens come out of the same max_tokens budget as the answer, so a
        // structured-output call can burn its whole budget thinking and return empty content.
        // Every call in this app wants one direct answer, never a chain of thought, so thinking
        // is switched off everywhere - this is not specific to the json path.
        thinking: { type: 'disabled' },
        ...(json ? { response_format: { type: 'json_object' } } : {})
      })
    });
    if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const msg = data.choices?.[0]?.message ?? {};
    const text = msg.content ?? '';
    // Defensive: if thinking ever turns itself back on server-side, fail with the
    // reasoning visible rather than a bare empty string that gives no clue why.
    if (!text && msg.reasoning_content) {
      throw new Error(`DeepSeek returned only reasoning, no content: ${msg.reasoning_content.slice(0, 400)}`);
    }
    if (!json) return text;
    try {
      return JSON.parse(text.replace(/^```json\s*|\s*```$/g, '').trim());
    } catch {
      throw new Error(`DeepSeek returned unparseable JSON: ${text.slice(0, 400)}`);
    }
  };
}

// ---------------------------------------------------------------- media sweep

/**
 * Pulls every feed in parallel, tolerates individual failures (dead feeds are
 * normal - see README), and returns a flat list of recent items. Media
 * attention is the gate for every sphere: an item this sweep does not surface
 * cannot qualify for an episode, no matter what a primary-source API says.
 */
// A real browser string. The previous "compatible; morgonbrief" pattern is a
// textbook bot signature and was being blocked by most news sites - 43 of 50
// article fetches failed on the first live run because of it.
export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export async function sweepMedia(feeds, { windowHours = 36, label = 'Sweep' } = {}) {
  const parser = new XMLParser({ ignoreAttributes: false });
  const cutoff = Date.now() - windowHours * 3600 * 1000;
  const items = [];

  const results = await Promise.allSettled(
    feeds.map(async (url) => {
      const res = await fetch(url, {
        headers: { 'user-agent': BROWSER_UA, accept: 'application/rss+xml, application/xml, text/xml, */*' },
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
        publishedAt: new Date(when).toISOString(),
        link: typeof e.link === 'string' ? e.link : e.link?.['@_href'] ?? ''
      });
    }
  }

  const failed = results.filter((r) => r.status === 'rejected').length;
  console.log(`${label}: ${items.length} items from ${feeds.length - failed}/${feeds.length} feeds`);
  return items;
}

// ---------------------------------------------------------------- article text

/**
 * Pulls readable body text out of an article page. No dependency, no headless
 * browser - just enough extraction to give the synthesis step real sentences
 * instead of an RSS teaser. Paywalls and bot-blocks are expected and must never
 * break a run: every failure returns null and the caller falls back to the feed
 * summary it already had.
 */
export async function fetchArticleText(url, { maxChars = 8000 } = {}) {
  if (!url) return null;
  try {
    const res = await fetch(url, {
      headers: {
        'user-agent': BROWSER_UA,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9,sv;q=0.8'
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) return null;
    if (!(res.headers.get('content-type') ?? '').includes('html')) return null;

    let html = await res.text();

    // Drop the furniture before looking for prose.
    for (const tag of ['script', 'style', 'noscript', 'nav', 'header', 'footer', 'aside', 'form', 'figure']) {
      html = html.replace(new RegExp(`<${tag}[\\s\\S]*?</${tag}>`, 'gi'), ' ');
    }

    // Prefer an <article> block when the page marks one up; otherwise take the body.
    const article = /<article[^>]*>([\s\S]*?)<\/article>/i.exec(html);
    const scope = article ? article[1] : (/<body[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1] ?? html);

    const paragraphs = [...scope.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
      .map((m) => strip(m[1]))
      .filter((p) => p.length > 60); // skip captions, bylines, cookie notices

    const text = paragraphs.join('\n\n').slice(0, maxChars);
    return text.length > 200 ? text : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- synthesis

/**
 * Synthesises the script. The voice is a taste decision and lives in
 * config.json, not here - but we still verify the configured voice actually
 * exists in this GCP project and fall back rather than failing the run.
 *
 * Chirp3-HD ignores speakingRate and pitch (Google's limitation, not ours), so
 * those are sent only for voice families that support them. If you want a
 * slower, heavier read than Chirp3 gives, switch family to Wavenet in config.
 */
export async function synthesize(script, serviceAccount, voiceConfig = {}) {
  const auth = new GoogleAuth({
    credentials: serviceAccount,
    scopes: ['https://www.googleapis.com/auth/cloud-platform']
  });
  const client = await auth.getClient();
  const token = (await client.getAccessToken()).token;
  const H = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  const list = await fetch('https://texttospeech.googleapis.com/v1/voices?languageCode=sv-SE', { headers: H });
  if (!list.ok) throw new Error(`TTS voices ${list.status}: ${await list.text()}`);
  const voices = (await list.json()).voices ?? [];

  const wanted = voiceConfig.name;
  const family = voiceConfig.family ?? 'Chirp3-HD';
  const pick =
    voices.find((v) => v.name === wanted) ??
    voices.find((v) => v.name.includes(family)) ??
    voices.find((v) => v.name.includes('Chirp3-HD')) ??
    voices[0];
  if (!pick) throw new Error('No Swedish voice available in this project');
  if (wanted && pick.name !== wanted) {
    console.log(`Voice: ${pick.name} (configured "${wanted}" not available in this project)`);
  } else {
    console.log(`Voice: ${pick.name}`);
  }

  // Rate and pitch are silently ignored by Chirp3-HD, so only send them where
  // they do something - otherwise the request is rejected outright.
  const supportsProsody = !pick.name.includes('Chirp');
  const audioConfig = { audioEncoding: 'MP3' };
  if (supportsProsody) {
    if (typeof voiceConfig.speakingRate === 'number') audioConfig.speakingRate = voiceConfig.speakingRate;
    if (typeof voiceConfig.pitch === 'number') audioConfig.pitch = voiceConfig.pitch;
  }

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
        audioConfig
      })
    });
    if (!res.ok) throw new Error(`TTS synth ${res.status}: ${await res.text()}`);
    parts.push(Buffer.from((await res.json()).audioContent, 'base64'));
    console.log(`  synthesised chunk ${i + 1}/${chunks.length}`);
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- script craft

/**
 * Builds the system prompt for a spoken segment. Shared by every sphere so that
 * a change to how the briefing sounds lands in one place rather than three, and
 * so the three spheres cannot drift into three different programmes.
 *
 * Order matters here. The listener profile comes before the structure, because
 * the structure's GROUND step is meaningless without knowing what this listener
 * already has - and it is the step most likely to be got wrong in both
 * directions: explaining the UN to someone who reads the news daily, or
 * dropping an acronym on someone who has never met it.
 */
export function scriptSystemPrompt(sphere, config = {}) {
  const listener = config.listener ?? {};
  const knowledge = listener.knowledge?.[sphere.id];
  const lines = ['You write a spoken Swedish briefing segment for one specific listener.'];

  if (listener.general) lines.push('', 'THE LISTENER', listener.general);
  if (knowledge) lines.push('', `WHAT HE ALREADY KNOWS ABOUT ${(sphere.label ?? sphere.id).toUpperCase()}`, knowledge);
  if (config.delivery) lines.push('', 'DELIVERY', config.delivery);

  if (config.segmentStructure?.length) {
    lines.push('', 'STRUCTURE - every segment follows these three moves in order');
    lines.push(...config.segmentStructure.map((s, i) => `${i + 1}. ${s}`));
  }

  if (config.craft?.length) {
    lines.push('', 'CRAFT');
    lines.push(...config.craft.map((c) => `- ${c}`));
  }

  if (sphere.scriptRules?.length) {
    lines.push('', `RULES SPECIFIC TO ${(sphere.label ?? sphere.id).toUpperCase()}`);
    lines.push(...sphere.scriptRules.map((r, i) => `${i + 1}. ${r}`));
  }

  return lines.join('\n');
}
