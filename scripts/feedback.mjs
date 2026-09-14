/**
 * feedback.mjs — reads the votes and moves one number.
 *
 * This is the only part of the system that changes its own behaviour, so it is
 * deliberately the narrowest thing that could be called a loop: it adjusts
 * knowledgeLevel per sphere, by at most one step, and nothing else. Scoring
 * weights are untouched. With one or two items a day per sphere, tuning those
 * on early taps would fit noise and call it taste.
 *
 * READ PATH: Firestore REST with the service account. Security rules do not
 * apply to service-account credentials - authorisation comes from IAM, where
 * the account holds Cloud Datastore Viewer. Read-only on purpose, which is why
 * the watermark lives in the repo rather than in Firestore.
 *
 * VOTE VALUES, and which question each answers:
 *   up / down       -> relevance: more or less of this KIND of subject
 *   deeper          -> "fördjupa imorgon": more of THIS subject
 *   harder / easier -> level: assume more or less of him
 *
 * Only harder/easier move anything today. The other three are recorded, counted
 * and reported, so that the material for the remaining loops accumulates from
 * the first day rather than from the day someone gets round to building them.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { SPHERE_KNOWLEDGE_DOMAIN } from './lib.mjs';

const STATE = new URL('../docs/feedback-state.json', import.meta.url);
const PROFILE = new URL('../profile.json', import.meta.url);

const WINDOW_DAYS = 14;
const STEP_AT = 3;      // net taps needed to move one level
const MIN_LEVEL = 1;
const MAX_LEVEL = 5;

/**
 * Which knowledgeLevel key each sphere's taps move.
 *
 * The canonical map lives in lib.mjs, because scriptSystemPrompt needs the same
 * one to decide which number a prompt is written to. Two copies would drift,
 * and drift here is silent: taps would move one number while the prompts read
 * another, which looks exactly like the loop doing nothing.
 *
 * The legacy alias below is local to this file because it is about votes, not
 * about spheres. Nothing writes val2026 any more, but votes cast under that id
 * are still in Firestore, and any that have not yet crossed the watermark would
 * otherwise be logged as mapping to no domain and dropped. The level itself
 * lives under the DOMAIN, so the accumulated calibration survived the rename
 * untouched - this only protects the taps still in flight.
 */
const SPHERE_TO_DOMAIN = {
  ...SPHERE_KNOWLEDGE_DOMAIN,
  val2026: 'swedishPolitics'
};

// ------------------------------------------------------------------ Firestore

function fromFirestoreValue(v) {
  if (!v || typeof v !== 'object') return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return null;
  return null;
}

/**
 * Pulls every feedback document. Pages through the whole collection rather than
 * filtering server-side: a structured query would need an index, and at a few
 * thousand documents the whole collection is cheaper than the operational
 * surface of maintaining one. Revisit if this ever crosses ~10k rows.
 */
export async function readVotes({ serviceAccount, pageSize = 300 }) {
  const { GoogleAuth } = await import('google-auth-library');
  const auth = new GoogleAuth({
    credentials: serviceAccount,
    scopes: ['https://www.googleapis.com/auth/cloud-platform']
  });
  const token = (await (await auth.getClient()).getAccessToken()).token;
  const base =
    `https://firestore.googleapis.com/v1/projects/${serviceAccount.project_id}` +
    `/databases/(default)/documents/feedback`;

  const votes = [];
  let pageToken = null;

  do {
    const url = new URL(base);
    url.searchParams.set('pageSize', String(pageSize));
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) {
      // Feedback must never take the brief down. A missing loop costs a day of
      // calibration; a failed run costs the episode.
      console.log(`Feedback: Firestore returned ${res.status} - skipping the loop this run`);
      return [];
    }

    const data = await res.json();
    for (const d of data.documents ?? []) {
      const f = d.fields ?? {};
      votes.push({
        id: d.name.split('/').pop(),
        itemId: fromFirestoreValue(f.itemId),
        sphere: fromFirestoreValue(f.sphere),
        vote: fromFirestoreValue(f.vote),
        // createdAt is serverTimestamp() in the app. `date` is the edition's
        // date string and is NOT a clock - never order by it.
        createdAt: fromFirestoreValue(f.createdAt),
        date: fromFirestoreValue(f.date)
      });
    }
    pageToken = data.nextPageToken ?? null;
  } while (pageToken);

  return votes.filter((v) => v.createdAt && v.sphere && v.vote);
}

// ---------------------------------------------------------------------- state

async function loadState() {
  try {
    return JSON.parse(await readFile(STATE, 'utf8'));
  } catch {
    return { watermark: null, pending: {}, history: [] };
  }
}

/**
 * Keeps the raw level-taps inside the window rather than a running integer.
 *
 * A single counter cannot expire its own contributions, so a tap from five
 * weeks ago would keep pushing forever. Holding the timestamps makes the
 * fourteen-day window real and makes every level change auditable afterwards:
 * the state file shows exactly which taps caused it.
 */
function pruneWindow(pending, now) {
  const cutoff = new Date(now.getTime() - WINDOW_DAYS * 86400_000).toISOString();
  const out = {};
  for (const [domain, taps] of Object.entries(pending)) {
    const kept = taps.filter((t) => t.at >= cutoff);
    if (kept.length) out[domain] = kept;
  }
  return out;
}

// ----------------------------------------------------------------------- loop

/**
 * Reads votes, moves levels, writes both files back.
 *
 * Returns a summary for the log. Never throws: every failure path degrades to
 * "no change this run".
 */
export async function applyFeedback({ serviceAccount, dryRun = false, votes = null }) {
  const now = new Date();
  const state = await loadState();
  const profile = JSON.parse(await readFile(PROFILE, 'utf8'));
  const levels = profile.interests.knowledgeLevel;

  // `votes` is an injection point for tests. In production it is null and the
  // votes come from Firestore.
  const all = votes ?? await readVotes({ serviceAccount });
  if (!all.length) {
    console.log('Feedback: no votes readable this run');
    return { changes: [], counted: 0 };
  }

  /**
   * The watermark alone is not enough. Two votes can carry the same
   * serverTimestamp, and a strict > would then drop one forever while a >=
   * would count the other twice every run. So the boundary timestamp is paired
   * with the ids that sit exactly on it, and only those are excluded.
   */
  const boundary = new Set(state.boundaryIds ?? []);
  const fresh = state.watermark
    ? all.filter((v) =>
        v.createdAt > state.watermark ||
        (v.createdAt === state.watermark && !boundary.has(v.id)))
    : all;

  const newest = all.reduce((m, v) => (v.createdAt > m ? v.createdAt : m), '');
  const boundaryIds = all.filter((v) => v.createdAt === newest).map((v) => v.id);

  // Everything gets counted and reported; only level taps act.
  const tally = { up: 0, down: 0, deeper: 0, harder: 0, easier: 0, other: 0 };
  const pending = pruneWindow(state.pending ?? {}, now);

  for (const v of fresh) {
    if (v.vote in tally) tally[v.vote]++; else tally.other++;
    if (v.vote !== 'harder' && v.vote !== 'easier') continue;

    const domain = SPHERE_TO_DOMAIN[v.sphere];
    if (!domain || !levels[domain]) {
      console.log(`Feedback: sphere "${v.sphere}" maps to no knowledge domain - tap ignored`);
      continue;
    }
    (pending[domain] ??= []).push({
      at: v.createdAt,
      delta: v.vote === 'harder' ? 1 : -1,
      itemId: v.itemId
    });
  }

  const changes = [];
  for (const [domain, taps] of Object.entries(pending)) {
    const net = taps.reduce((n, t) => n + t.delta, 0);
    if (Math.abs(net) < STEP_AT) continue;

    const before = levels[domain].level;
    const after = Math.min(MAX_LEVEL, Math.max(MIN_LEVEL, before + Math.sign(net)));
    if (after === before) {
      // Already at the ceiling or floor. Clear the taps anyway, or they sit
      // there forever and fire again the moment the level moves off the bound.
      pending[domain] = [];
      console.log(`Feedback: ${domain} is already at ${before}, cannot go further - taps cleared`);
      continue;
    }

    levels[domain].level = after;
    pending[domain] = []; // one step per threshold, then reset
    changes.push({ domain, before, after, net, taps: taps.length, at: now.toISOString() });
  }

  console.log(
    `Feedback: ${fresh.length} new vote(s) — ` +
    `mer ${tally.up}, mindre ${tally.down}, fördjupa ${tally.deeper}, ` +
    `svårare ${tally.harder}, enklare ${tally.easier}` +
    (tally.other ? `, okänd ${tally.other}` : '')
  );
  for (const c of changes) {
    console.log(`  LEVEL ${c.domain}: ${c.before} -> ${c.after} (net ${c.net > 0 ? '+' : ''}${c.net} over ${c.taps} tap(s))`);
  }
  if (!changes.length) {
    const near = Object.entries(pending)
      .map(([d, t]) => `${d} ${t.reduce((n, x) => n + x.delta, 0)}/${STEP_AT}`)
      .join(', ');
    if (near) console.log(`  no level moved — standing: ${near}`);
  }

  if (dryRun) {
    console.log('Feedback: dry run, nothing written');
    return { changes, counted: fresh.length, tally };
  }

  await writeFile(
    STATE,
    JSON.stringify({
      watermark: newest || state.watermark,
      boundaryIds: newest ? boundaryIds : (state.boundaryIds ?? []),
      updatedAt: now.toISOString(),
      pending,
      history: [...(state.history ?? []), ...changes].slice(-200)
    }, null, 2) + '\n',
    'utf8'
  );
  await writeFile(PROFILE, JSON.stringify(profile, null, 2) + '\n', 'utf8');

  return { changes, counted: fresh.length, tally };
}
