# Morgonbrief

A daily Swedish brief for someone who has already read the news. Two tiers come
out of one sweep, because they want opposite things:

- **Feed** — everything the sweep found inside the active spheres, clustered by
  story, rewritten in Swedish and synthesised across sources. No threshold,
  ~15–25 entries. Clusters with two or more independent sources get their
  article text fetched, so the synthesis works on real sentences rather than RSS
  teasers. This is the Omni replacement, scoped to the spheres.
- **Pod** — only what cleared the sphere's threshold, grounded in primary
  documents. Usually zero to two items. This is the drive.

The model never scores and never recalls a fact. It clusters, and it writes from
material already in front of it. Entries are rewritten in full, never
reproduced, and always link back to their sources.

Two spheres ship today:

- **US Congress** — coverage links to a specific bill; Congress.gov supplies its
  text, actions and cosponsor list.
- **Crypto** — coverage links to a governance-forum proposal (Discourse API) or
  a sized on-chain move (DefiLlama). No X/Twitter, deliberately — see below.

`scripts/lib.mjs` holds what everything shares (DeepSeek, the RSS sweep, article
extraction, TTS). `scripts/feed.mjs` is the feed tier. `scripts/sphere-*.mjs` is
the pod tier per sphere. `scripts/run.mjs` orchestrates both and writes
`docs/feed.json`, which the workflow commits so the app reads it same-origin —
cacheable, no CORS, and it still works in a tunnel.

## Setup

**1. Make the repository public.** Release assets in a private repo need
authentication, so the app could not fetch the audio. Nothing secret lives in the
code; the keys are Actions secrets, which stay private either way.

**2. Add three repository secrets.** Settings → Secrets and variables → Actions:

| Secret | Value |
| --- | --- |
| `DEEPSEEK_API_KEY` | the DeepSeek key |
| `CONGRESS_API_KEY` | the api.data.gov key |
| `GCP_SERVICE_ACCOUNT` | the whole service-account JSON, pasted as one value |

**3. Turn on Pages.** Settings → Pages → Source: *Deploy from a branch* →
branch `main`, folder `/docs`.

**4. Publish the Firestore rules.** Firebase console → Firestore → Rules, paste
`firestore.rules`, Publish. Firestore now only stores feedback — the brief is a
static file — so a failure here costs you the thumbs buttons, not the app.

**4b. Enable Anonymous sign-in.** Firebase console → Authentication → Sign-in
method → Add new provider → Anonymous. Same reason: feedback only.

**5. Run it once by hand.** Actions → Morgonbrief → Run workflow. Read the log
before trusting anything: it prints how many feeds answered, how many headlines
mapped to a bill, every score with its reasons, and which Swedish voice the
project actually has.

Then open the Pages URL in Chrome on the phone. It should offer to install —
the manifest, the icons and the service worker are all in place. Installed, it
opens without browser chrome and keeps today's episode and feed available
offline.

## What the log tells you

- `sweep: N items from X/Y feeds` — dead feeds are normal; delete them from the
  sphere's JSON rather than debugging them.
- `Linked N candidate(s)` — zero means the day's coverage had nothing tied to a
  primary source. A real answer, not a bug.
- `scored N, qualified M` — `M` is capped by `maxItemsPerEpisode`. An empty
  episode is the correct output on a quiet day, and the script says so out loud.
- `Feed: N items clustered into M stories` — if `M` is close to `N`, clustering
  is not grouping and the feed will read repetitive. That is the number to watch.
- `Feed: fetched article text for N source(s), M unavailable` — some paywalls and
  bot-blocks are expected. If `N` is zero, synthesis is running on teasers only
  and will read thin.

## Tuning

Each `spheres/*.json` is that sphere's whole editorial policy: which feeds count,
what scoring counts as important, the threshold, and the rules the script must
obey. Raising `threshold` makes episodes rarer and better. Nothing in `scripts/`
needs touching to change what gets covered — only to add a genuinely new kind of
sphere (a new primary source, a new scoring shape).

To add a sphere: write `spheres/<id>.json`, add a `run<Id>()` function in
`run.mjs` following the congress/crypto pattern, and register it in `RUNNERS`.

## Deliberately not in v0

- **No learning loop yet.** The app records votes to `feedback`, but nothing reads
  them. Collect a couple of weeks first — with one or two items a day per sphere,
  adjusting weights on early noise would lock in randomness.
- **No entity queue.** "Fördjupa imorgon" is stored, not yet acted on.
- **No search sweep.** Adding Brave would let the deep-dive follow a thread beyond
  the primary source. Worth doing once both spheres run clean for a while.
- **No X/Twitter in the crypto sphere.** X's API now costs per read with no free
  tier; third-party readers are cheaper but sit in a gray area against X's terms.
  v0 covers "trustworthy independent voices" via their RSS/Substack/Mirror feeds
  instead. Revisit as a deliberate, separate decision.
- **No football sphere yet.** Comes after both current spheres run clean for a
  week or two.

## Crypto sphere specifics

`governanceForums` lists Discourse instances by base URL only — the pipeline
calls `{base}/latest.json` and `{base}/t/{id}.json`, both public, no key. Add a
DAO by adding its forum's base URL.

Scoring is deliberately two-shaped: a governance vote is scored by how contested
it is (reply count), a chain move by DefiLlama's own TVL numbers against
`tvlMoveThresholds`. The model never invents either number — `writeCards` and
`writeScript` are only allowed to restate what `fetchPrimarySource` returned.

## Rotate the keys

All three keys passed through a chat transcript while this was being built.
Once the pipeline runs reliably, regenerate each one and update the secrets:
DeepSeek platform, api.data.gov, and Firebase → Project settings → Service
accounts.
