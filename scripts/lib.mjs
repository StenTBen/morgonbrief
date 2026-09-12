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
  };
}

// ---------------------------------------------------------------- media sweep

/**
 * Pulls every feed in parallel, tolerates individual failures (dead feeds are
 * normal - see README), and returns a flat list of recent items. Media
 * attention is the gate for every sphere: an item this sweep does not surface
 * cannot qualify for an episode, no matter what a primary-source API says.
 */
export async function sweepMedia(feeds, { windowHours = 36, label = 'Sweep' } = {}) {
  const parser = new XMLParser({ ignoreAttributes: false });
  const cutoff = Date.now() - windowHours * 3600 * 1000;
  const items = [];

  const results = await Promise.allSettled(
    feeds.map(async (url) => {
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
        'user-agent': 'Mozilla/5.0 (compatible; morgonbrief/0.2)',
        accept: 'text/html,application/xhtml+xml'
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
 * Picks the best Swedish voice this GCP project actually has (never hardcodes
 * a name that might not exist), splits the script on sentence boundaries to
 * respect the per-request character cap, and concatenates the resulting MP3
 * frames into one buffer.
 */
export async function synthesize(script, serviceAccount) {
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
  const pick =
    voices.find((v) => v.name.includes('Chirp3-HD')) ??
    voices.find((v) => v.name.includes('Wavenet')) ??
    voices.find((v) => v.name.includes('Neural2')) ??
    voices[0];
  if (!pick) throw new Error('No Swedish voice available in this project');
  console.log(`Voice: ${pick.name}`);

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
