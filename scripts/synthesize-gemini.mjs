/**
 * Gemini-TTS synthesis, with the existing Chirp path as fallback.
 *
 * Three things synthesize() in lib.mjs cannot do, each of which matters:
 *
 * 1. It sends `input: { text }`. Pause tags only work in `input: { markup }`.
 *    Sent as text they are READ ALOUD — "left bracket long pause right bracket".
 *
 * 2. It chunks at 4200 CHARACTERS. The Gemini-TTS limit is 4000 BYTES, and
 *    Swedish å/ä/ö are two bytes each in UTF-8, so a 4200-character Swedish
 *    script is roughly 4400+ bytes and is rejected.
 *
 * 3. It has no concept of refusal. Gemini-TTS runs safety filters; a brief
 *    about war or violence can return a support code instead of audio. Logged
 *    as silence, that looks exactly like a quiet news day.
 *
 * The voice-discovery and fallback logic in lib.mjs is good and is reused here
 * rather than reinvented.
 */

import { GoogleAuth } from 'google-auth-library';

const SYNTH_URL = 'https://texttospeech.googleapis.com/v1/text:synthesize';
const VOICES_URL = 'https://texttospeech.googleapis.com/v1/voices?languageCode=sv-SE';

export class TtsRefusal extends Error {
  constructor(message, supportCode) {
    super(message);
    this.name = 'TtsRefusal';
    this.supportCode = supportCode;
  }
}

const bytes = (s) => Buffer.byteLength(s, 'utf8');

/**
 * Byte-aware chunking on sentence boundaries.
 *
 * The default is 3600, not 4000: prompt and text share an 8000-byte combined
 * ceiling and the style prompt is not free. Headroom is cheaper than finding
 * the ceiling at 04:00.
 */
export function chunkByBytes(script, maxBytes = 3600) {
  const chunks = [];
  let buf = '';
  for (const sentence of script.split(/(?<=[.!?])\s+/)) {
    const candidate = buf ? `${buf} ${sentence}` : sentence;
    if (bytes(candidate) > maxBytes && buf) {
      chunks.push(buf.trim());
      buf = sentence;
    } else {
      buf = candidate;
    }
  }
  if (buf.trim()) chunks.push(buf.trim());
  // A single sentence over the cap would otherwise ship oversized and 400.
  return chunks.flatMap((c) => (bytes(c) <= maxBytes ? [c] : splitHard(c, maxBytes)));
}

function splitHard(text, maxBytes) {
  const out = [];
  let buf = '';
  for (const word of text.split(/\s+/)) {
    const candidate = buf ? `${buf} ${word}` : word;
    if (bytes(candidate) > maxBytes && buf) { out.push(buf); buf = word; }
    else buf = candidate;
  }
  if (buf) out.push(buf);
  return out;
}

async function authHeaders(serviceAccount) {
  const auth = new GoogleAuth({
    credentials: serviceAccount,
    scopes: ['https://www.googleapis.com/auth/cloud-platform']
  });
  const client = await auth.getClient();
  const token = (await client.getAccessToken()).token;
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

async function pickFallbackVoice(headers, fallback = {}) {
  const list = await fetch(VOICES_URL, { headers });
  if (!list.ok) throw new Error(`TTS voices ${list.status}: ${await list.text()}`);
  const voices = (await list.json()).voices ?? [];
  const byName = (n) => voices.find((v) => v.name === n);

  // Configured alternatives before any generic family match - otherwise the
  // family step picks whichever Chirp3-HD voice sorts first, which is Achernar,
  // a female voice. Falling back should change the voice, never its gender.
  const alternatives = Array.isArray(fallback.alternatives) ? fallback.alternatives : [];
  const pick =
    byName(fallback.name) ??
    alternatives.map(byName).find(Boolean) ??
    voices.find((v) => v.name.includes(fallback.family ?? 'Chirp3-HD')) ??
    voices.find((v) => v.name.includes('Chirp3-HD')) ??
    voices[0];
  if (!pick) throw new Error('No Swedish voice available in this project');
  if (!alternatives.includes(pick.name) && pick.name !== fallback.name) {
    console.log(`  TTS: WARNING fell past every configured alternative to ${pick.name}`);
  }
  return pick.name;
}

async function post(headers, body, label) {
  const res = await fetch(SYNTH_URL, { method: 'POST', headers, body: JSON.stringify(body) });
  const raw = await res.text();
  if (!res.ok) {
    // "Support codes: 62263041" and friends. A refusal, not an outage.
    const code = /Support codes?:\s*(\d+)/i.exec(raw)?.[1];
    if (code || /usage guidelines/i.test(raw)) {
      throw new TtsRefusal(`TTS refused to synthesize ${label}`, code ?? 'unknown');
    }
    throw new Error(`TTS synth ${res.status}: ${raw.slice(0, 400)}`);
  }
  return Buffer.from(JSON.parse(raw).audioContent, 'base64');
}

/**
 * @param {string} markup         speakable() output, with [pause] tags
 * @param {object} serviceAccount
 * @param {object} ttsConfig      config.tts
 * @returns {Promise<{audio: Buffer, usedFallback: boolean, refusals: object[]}>}
 */
export async function synthesizeGemini(markup, serviceAccount, ttsConfig) {
  const headers = await authHeaders(serviceAccount);
  const primary = ttsConfig.primary;
  const cap = (primary.limits?.textBytes ?? 4000) - 400;
  const chunks = chunkByBytes(markup, cap);

  console.log(`TTS: ${chunks.length} chunk(s) via ${primary.model}`);

  const parts = [];
  const refusals = [];
  let usedFallback = false;
  let fallbackVoice = null;

  for (const [i, chunk] of chunks.entries()) {
    const label = `chunk ${i + 1}/${chunks.length}`;
    try {
      parts.push(await post(headers, {
        input: {
          // The style prompt is the largest single lever on how human the read
          // sounds. Chirp has no equivalent field.
          prompt: primary.stylePrompt,
          markup: chunk
        },
        voice: {
          languageCode: primary.languageCode,
          name: primary.voiceId,
          modelName: primary.model
        },
        audioConfig: { audioEncoding: 'MP3' }
      }, label));
      console.log(`  ${label} ok`);
      continue;
    } catch (e) {
      if (e instanceof TtsRefusal) {
        console.log(`  ${label} REFUSED (support code ${e.supportCode}) — named, not silent`);
        refusals.push({ chunk: i, supportCode: e.supportCode });
        continue;
      }
      console.log(`  ${label} failed on primary: ${e.message}`);
    }

    // Fallback. Chirp 3: HD has no style control at all, and lib.mjs already
    // found empirically that it ignores speakingRate and pitch — so no
    // controls, plain text, and pause markers stripped rather than spoken.
    fallbackVoice ??= await pickFallbackVoice(headers, ttsConfig.fallback);
    usedFallback = true;
    parts.push(await post(headers, {
      input: { text: chunk.replace(/\[(short |medium |long )?pause\]/g, ' ') },
      voice: { languageCode: 'sv-SE', name: fallbackVoice },
      audioConfig: { audioEncoding: 'MP3' }
    }, `${label} (fallback ${fallbackVoice})`));
    console.log(`  ${label} ok via fallback ${fallbackVoice}`);
  }

  if (!parts.length) throw new Error('TTS produced no audio at all');
  if (refusals.length) console.log(`TTS: ${refusals.length} chunk(s) refused and omitted`);
  return { audio: Buffer.concat(parts), usedFallback, refusals };
}
