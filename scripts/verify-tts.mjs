/**
 * verify-tts.mjs
 *
 * Makes ONE real Gemini-TTS call using the project's own config.json, so the
 * thing being tested is the actual configuration rather than a copy of it.
 *
 * It exists because the alternative is waiting for 02:00 to learn whether an
 * IAM change took. Four gates can fail here and they look alike from outside:
 *
 *   1. wrong service account in the secret
 *   2. the account cannot mint a token
 *   3. the account lacks aiplatform.user (403) or the API is off
 *   4. the request body is malformed, or the model/voice is wrong (400)
 *
 * Delete this file and its workflow once the nightly run is producing
 * Gemini audio without falling back.
 */

import { readFile } from 'node:fs/promises';

const SYNTH_URL = 'https://texttospeech.googleapis.com/v1/text:synthesize';

// Short on purpose: this costs real money and proves the same thing at ten
// words as at a thousand. The pause tags are here because they are the part
// that was broken.
const SAMPLE =
  'Det här är ett test. [medium pause] Riksbanken lämnade räntan oförändrad. ' +
  '[short pause] Mer om det imorgon.';

function line() { console.log('─'.repeat(58)); }

let creds;
try {
  creds = JSON.parse(process.env.GCP_SERVICE_ACCOUNT ?? '');
} catch {
  console.error('FAIL: GCP_SERVICE_ACCOUNT is missing or is not valid JSON.');
  process.exit(1);
}

const config = JSON.parse(await readFile(new URL('../config.json', import.meta.url), 'utf8'));
const primary = config.tts?.primary;
if (!primary) {
  console.error('FAIL: config.json has no tts.primary block.');
  process.exit(1);
}

line();
console.log('STEP 1  Identity and config');
console.log(`  client_email : ${creds.client_email}`);
console.log(`  project      : ${creds.project_id}`);
console.log(`  model        : ${primary.model}`);
console.log(`  voice        : ${primary.voiceId}   language: ${primary.languageCode}`);
console.log('');
console.log('  >> client_email must be the account you granted the Agent Platform');
console.log('     (Vertex AI) User role to. The project has more than one service');
console.log('     account and only this one is in the secret.');
line();

let token;
try {
  const { GoogleAuth } = await import('google-auth-library');
  const auth = new GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/cloud-platform']
  });
  token = (await (await auth.getClient()).getAccessToken()).token;
  if (!token) throw new Error('no token returned');
} catch (e) {
  console.error(`FAIL: could not mint an access token - ${e.message}`);
  process.exit(1);
}
console.log('STEP 2  Access token minted');
line();

const body = {
  input: {
    prompt: primary.stylePrompt,
    // text, NOT markup. markup is a Chirp-only field and Gemini rejects it.
    text: SAMPLE
  },
  voice: {
    languageCode: primary.languageCode,
    name: primary.voiceId,
    modelName: primary.model
  },
  audioConfig: { audioEncoding: 'MP3' }
};

console.log('STEP 3  Calling Gemini-TTS for real');
const res = await fetch(SYNTH_URL, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify(body)
});
const raw = await res.text();
console.log(`  HTTP ${res.status}`);
line();

// A refusal is a 4xx that is not a configuration problem. Worth separating,
// because chasing an IAM bug that is actually a safety filter wastes an evening.
const support = /Support codes?:\s*(\d+)/i.exec(raw)?.[1];
if (support) {
  console.log('REFUSAL, not a configuration problem.');
  console.log(`  support code ${support} - the sample text tripped a safety filter.`);
  console.log('  Auth and the request body are both fine. Nothing to fix in IAM.');
  process.exit(0);
}

if (res.status === 403) {
  console.error('FAIL: PERMISSION DENIED (403).');
  console.error('');
  console.error('In order of likelihood:');
  console.error('  a) The role landed on a different service account than the one above.');
  console.error('  b) The role granted was not the right one. The display name is now');
  console.error('     "Agent Platform User"; the id that matters is roles/aiplatform.user.');
  console.error('     Several Agent Platform roles have near-identical names.');
  console.error('  c) Not propagated yet - wait two minutes and rerun before changing anything.');
  console.error('');
  console.error(raw.slice(0, 700));
  process.exit(1);
}

if (res.status === 400) {
  console.error('FAIL: BAD REQUEST (400). Auth is fine; the body or the config is not.');
  console.error('');
  console.error('If it mentions markup, an old copy of synthesize-gemini.mjs is deployed.');
  console.error('If it mentions the voice, primary.voiceId should be the SHORT name');
  console.error(`("Charon"), not the full Chirp form - currently "${primary.voiceId}".`);
  console.error('');
  console.error(raw.slice(0, 700));
  process.exit(1);
}

if (!res.ok) {
  console.error(`FAIL: unexpected status ${res.status}`);
  console.error(raw.slice(0, 700));
  process.exit(1);
}

const audio = Buffer.from(JSON.parse(raw).audioContent, 'base64');
console.log('PASS  Gemini-TTS returned audio.');
console.log('');
console.log(`  ${audio.length.toLocaleString('sv-SE')} bytes of MP3`);
console.log('  The style prompt was accepted, and the pause tags went through as text.');
console.log('');
console.log('  The nightly run should now stop logging "fell back to Chirp".');
console.log('  If it still does, the failure is in a later chunk, not in access -');
console.log('  check the byte cap rather than IAM.');
line();
