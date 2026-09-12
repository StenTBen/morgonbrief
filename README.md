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

Four spheres ship today:

- **US Congress** — coverage links to a specific bill; Congress.gov supplies its
  text, actions and cosponsor list.
- **Crypto** — coverage links to a governance-forum proposal (Discourse API) or
  a sized on-chain move (DefiLlama). No X/Twitter, deliberately — see below.
- **World** — works by subtraction. Sweeps international feeds alongside a
  Swedish shadow set and surfaces only what Swedish press did not carry.
- **val2026** — the Swedish election. An ordinary nightly sphere, except on
  election day, when a separate workflow pulses it every 30 minutes. See below.

A sphere is activated by `"status": "active"` — the string. `run.mjs` filters on
`s.status === 'active'`, so a boolean `active: true` loads nothing and prints no
error; the sphere simply never appears in the "Active spheres:" line. A sphere
with no entry in `POD_RUNNERS` is feed-only and the log says so, which is a
supported configuration rather than an oversight.

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


## The val2026 sphere

This one breaks the pattern the other three share, and the reason is worth
stating plainly.

In Congress, Crypto and World the candidate is a document the coverage pointed
at, and arithmetic asks whether the coverage was loud enough. On election night
that stops working: everything is covered, so volume stops discriminating.

So the candidate here is a **pattern measured across runs**. The 30-minute
cadence is not about freshness — it builds a time series, and the time series is
what makes an aggregate observation countable instead of a matter of opinion.

It runs from its own entry point (`npm run pulse`), not through `run.mjs`, for
two reasons: `run.mjs` has no sphere flag and exits non-zero when nothing is
produced, and a 30-minute cadence must never be able to wedge the daily brief.

The pulse window is noon to 23:00 on election day. After it closes, val2026 is
an ordinary nightly sphere carried in the feed alongside the other three. The
two never overlap — the window ends at 23:00 and the nightly run fires at 02:00
— so there is no duplicate risk and nothing to switch over.

Each pulse:

1. Sweeps a generous 3h window and dedupes against `docs/val-ledger.json` by
   link hash. `sweepMedia` takes `windowHours`, not a since-timestamp, and
   Actions cron drifts, so the hash does the real work. That dedupe is what
   makes a wide window safe — do not narrow the window instead of trusting it.
2. Clusters lexically, crude on purpose, capped at 99 clusters.
3. Asks the model for **observations only**, in batches of 25: entities named,
   claim type, and a cause-effect link *only if a source states it*, with the
   asserting outlet named. 99 clusters in one call would overrun the output
   ceiling — the trap already in STATUS.
4. Runs `detectPatterns()` and `detectTransitions()` — pure arithmetic over the
   ledger.
5. Publishes the strongest unpublished candidate.

### Why the gates rank instead of admitting

Every other sphere has a hard threshold and an empty episode is a correct
answer. Here the requirement is 1–2 entries an hour, and a hard threshold would
simply produce nothing on a slow hour.

So the gates assign the strongest label the counts earn — `stark`, `medel`,
`tunn` — the best candidate is published, and **the label travels with the
entry** as `styrka` and `underlag`. A thin hour reads as thin rather than being
dressed up. That is the honest half of what a hard gate was protecting, and the
sphere's script rules require the text to say so in words rather than write
around it.

If no link qualifies at all, the largest unpublished cluster is published as
`tunn`. The sphere always produces.

### Rumours

Read deliberately, in three provenance tiers: `verified` (the text cites a
primary document), `reported` (a named outlet under its own byline),
`circulating` (in circulation, unconfirmed).

A circulating item is described **as circulation** — that the claim spread and
was not confirmed — never restated as content, and it may never carry an entry
alone. The one exception: when a circulating claim crosses into editorial pickup
by two or more independent outlets, the crossing is the story rather than the
claim.

### What "primary source" means here

Full article text, not Valmyndigheten. Their machine-readable endpoint is
unverified, and building against an unverified endpoint the day before an
election fails in a way that reads exactly like a quiet news day. The ledger
records what the teasers said; the full text is what the reader has not seen.
Riksdagen's open API is the upgrade after the election, not before it.

### Watching it

- `ledger +N, -M aged out` — N near zero across several pulses means the window
  or the feeds are wrong.
- `stark` / `medel` / `tunn` on each published line — a run of nothing but
  `tunn` means the sweep is not finding repeated assertions, not that the
  election is quiet.
- `DEAD FEED <url>` — remove it from the sphere JSON. A dead feed here
  under-counts circulation, which pushes pattern counts *toward* the gates. It
  does not merely lose stories, it invents them.
- `WARNING: clustering is not grouping` — counts are inflating; raise the
  overlap threshold.

## Making the read sound human

The bar is that the narration beats the human hosts on Swedish news podcasts. It
does not yet.

**Voice.** Gemini-TTS (`sv-SE`, Preview) is primary; Chirp 3: HD is a bare
fallback with no controls. Google classifies Chirp 3: HD as a
conversational-agent voice; the media tiers are Studio narration and Studio
multispeaker, which appear to be English-only. Gemini-TTS is the only sv-SE
option with a style prompt, and the style prompt is the largest single lever.

`lib.mjs` already records, empirically, that Chirp3-HD ignores `speakingRate`
and `pitch`. Google's own two documentation pages disagree on that point; our
code is the tiebreaker.

**Pronunciation lives in the text.** Custom pronunciations are unavailable for
`sv-SE`, so there is no phoneme override. `scripts/speakable.mjs` applies
deterministic rules and a lexicon to the finished script immediately before
synthesis — Swedish respelling, never IPA. Not a model pass: a model rewriting a
finished script is a new place for figures to drift.

**Pause tags need the markup field.** `input: { text }` reads them aloud,
literally. `scripts/synthesize-gemini.mjs` uses `input: { markup }`.

**Chunking is byte-aware.** The limit is 4000 bytes, not characters, and Swedish
å/ä/ö are two bytes each — 4200 characters of Swedish is over the cap.

**The unresolved log is the mechanism.** Capitalised names and acronyms the
lexicon did not know go to `docs/unresolved-terms.json`. Promote them and the
same name is never mispronounced twice. Without promotion the effort costs the
same every night forever and never improves.

**Refusal is a named failure.** Gemini-TTS runs safety filters; a brief about war
or violence can return a support code instead of audio. Logged as `TTS refused`,
never as a quiet day.
