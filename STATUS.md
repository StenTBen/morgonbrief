# Status

Working notes, updated when something changes. The README explains how the
system works; this records where it stands and what is unresolved.

## Where it stands

Four spheres: Congress, Crypto, World, val2026. The first three run nightly.
val2026 is an ordinary nightly sphere too, except on election day, when a
separate workflow pulses it every 30 minutes from noon to 23:00. Two tiers come
out of the nightly sweep: a feed of ~25 rewritten and synthesised entries, and
per-sphere audio episodes gated by a threshold. The app is a PWA on GitHub
Pages, installable, works offline. Voice, listener knowledge profile, craft
rules and every input and output limit live in `config.json`.

## Open problems

**Congress has linked zero bills four runs in a row.** `linkCoverage` runs on
fetched article text, not teasers, so the obvious explanation is out. But
article fetch only succeeds for roughly a third of sources, so it still sees
teasers for the rest. Log the near-misses before touching the prompt.

**Article fetch rate is still mediocre.** The browser user-agent took it from
7/50 to 12/36. The rest are paywalls and bot-blocks, which no user-agent fixes.
Where fetches fail the synthesis runs on RSS teasers and reads thinner. The feed
marks these entries, so the effect is visible rather than hidden. This now
matters more: val2026 uses full article text *as* its primary-source layer, so a
low fetch rate there does not just thin the prose, it removes the thing the
publication decision is measured against.

**Feedback votes go nowhere.** Written to Firestore, remembered on the device,
read by nothing. Deliberate until a couple of weeks of data exist. The pipeline
dropped its `firebase-admin` import when the app moved to a static `feed.json`,
so wiring the loop means re-adding it.

**The entity queue is still unbuilt.** "Fördjupa imorgon" is stored, not acted
on. Worth more than the feedback loop: votes tune taste, the queue builds
series, and series is what separates a brief from a summary. Also unblocked.

**No continuity across days.** `docs/seen.json` prevents repeats but carries no
thread identity, so nothing can say "third time this month". A deterministic
join on bill number or proposal id would, with no model judgement anywhere. The
val2026 ledger is a scoped prototype of exactly this; the general case is open
and is the largest single lever on journalistic depth.

**Valmyndigheten's endpoint is unverified.** val2026 therefore uses full article
text as its primary-source layer. Riksdagen's open API is the upgrade after the
election, not before it.

**val2026 feed URLs are untested.** Twenty-eight of them, written from general
knowledge of Swedish outlets. Verify before the first pulse.

## Audio

The read still sounds synthetic. The bar is that it beats the human hosts on
Swedish news podcasts. Decisions taken:

- **Gemini-TTS primary, Chirp 3: HD a bare fallback.** Google's taxonomy puts
  Chirp 3: HD under "Conversational Agents" with no controllability; the media
  tiers are Studio narration and Studio multispeaker, which appear to be
  English-only across every locale in the voice table.
- **Our own code settled the documentation contradiction.** Two Google pages
  dated 2026-09-09 disagree about whether Chirp 3: HD supports SSML and
  `speaking_rate`. The comment in `config.json` and in `synthesize()` records
  that Chirp3-HD ignores rate and pitch — found empirically here. Treat Chirp as
  having no controls.
- **sv-SE on Gemini-TTS is Preview.** GA would normally win; that rule breaks
  here only because the GA option lacks the feature.
- **Pronunciation is solved in the text.** No phoneme override exists for sv-SE,
  so the output is Swedish respelling, never IPA.
- **Normalization is deterministic.** `scripts/speakable.mjs`, rules plus
  lexicon, on the finished script immediately before synthesis. Not a model
  pass: a model rewriting a finished script is a new place for figures to drift.
- **The unresolved-token log is the learning mechanism.** Capitalised names and
  acronyms the lexicon did not know go to `docs/unresolved-terms.json` for
  promotion. Without promotion the repair loop costs the same every night
  forever and never improves.
- **Dialogue is the target format**, modelled on Aftonbladet Daily. The humanity
  comes from someone asking, not from timbre. The host's questions may only
  refer to material the reporter has already stated in the same episode — which
  also makes the most human-sounding half of the script structurally incapable
  of inventing anything. Disabled until a single-voice reference exists to
  measure against.

## Design invariants

Breaking one produces something that looks like it works and is quietly worse.

- **The model never scores editorially.** It reports observations — how many
  outlets, whether a Swedish match exists, how many cosponsors, which link a
  source asserted. Arithmetic decides what qualifies.
  *The model may judge how a generated read sounds.* Editorial scoring and craft
  QA are different things; this sentence exists so the distinction is not
  collapsed by whoever reads the file next.
- **Media attention is the gate, primary sources supply the substance.** A story
  the sweep did not surface cannot qualify.
  *Scoped exception, val2026:* on election night everything is covered, so
  volume stops discriminating and frequency across runs replaces it. The sweep
  is still the gate for what exists.
- **Silence means "covered", never "gap".** In the world sphere anything the
  model omits is folded in as Swedish-covered. In val2026, omission means
  "nothing new on this thread", never "thread closed". Forgetting must never
  manufacture a signal.
- **An empty episode is a correct answer** — in the pod tier. val2026 is the one
  deliberate exception: its gates rank rather than admit, because the
  requirement there is 1–2 entries an hour and a hard threshold produces nothing
  on a slow hour. The compensation is that the strength label travels with the
  entry, so a thin hour reads as thin. Do not copy that exception into any other
  sphere without the same compensation.
- **Rewrite, never reproduce.** Entries are written in Karl's own reading
  language and always link back to their sources.
- **Rumours are described as circulation, never restated as content.** A
  circulating item may never carry an entry alone. The one exception is the
  crossing into editorial pickup, which is itself the story.
- **One failing sphere must not take down the others**, and a truncated model
  answer must be named as truncation rather than blamed on the format. This
  applies to workflows too: val2026 pulses in its own workflow.
- **TTS refusal is a named failure.** A safety-filter refusal returns a support
  code, not audio. Never logged as silence.

## Traps already hit

- DeepSeek V4-family models think by default; reasoning tokens come out of the
  same `max_tokens` budget as the answer. `makeDeepseek` sends
  `thinking: {type:"disabled"}` and throws if only `reasoning_content` returns.
- `makeDeepseek` **throws** on `finish_reason === 'length'` rather than returning
  a flag. Every call site must catch, or one truncated response kills the run.
- Asking the model to report on *all* stories rather than only the gaps
  overflowed the output cap. This is why val2026 batches observations at 25
  clusters rather than sending all 99 in one call.
- Input caps truncate silently and degrade quality invisibly; output caps fail
  loudly. The input ones did the real damage.
- A sphere's own `scriptRules` can contradict `config.segmentStructure`.
  `scriptSystemPrompt` renders sphere rules *after* the structure.
- The service worker served the app document cache-first, so installed copies
  kept showing old designs. Navigation is network-first; bump `VERSION` in
  `sw.js` when the shell list changes.
- **A sphere is activated by `status: "active"`, a string.** A boolean
  `active: true` loads nothing and prints no error.
- **`synthesize()` sends `input: { text }`.** Pause tags only work in
  `input: { markup }`. Sent as text they are read aloud, literally.
- **The old chunker split at 4200 characters; the limit is 4000 bytes.** Swedish
  å/ä/ö are two bytes each in UTF-8, so 4200 characters of Swedish overruns the
  cap. `synthesize-gemini.mjs` chunks by bytes with headroom, because prompt and
  text share an 8000-byte combined ceiling.
- **Google's own TTS docs contradict each other.** Test any control before
  depending on it.
- **Actions cron is unreliable at 30-minute granularity.** Runs are delayed and
  sometimes skipped. Never compute a lookback from the clock; sweep a generous
  window and dedupe by link hash. `sweepMedia` takes `windowHours`, not a
  since-timestamp, so the hash does the real work.
- **Splicing a re-generated few seconds of audio does not work.** Neural TTS is
  not deterministic between runs; the seam is audible. Repair whole chunks.
- **`sweepMedia` items have `source` and `link`, not `outlet` and `url`,** and
  carry no id. Anything keying off them needs its own hash.
- **`expandParties` duplicated the party name.** "Moderaterna (M)" became
  "Moderaterna från Moderaterna"; the rule was written for "Ulf Kristersson (M)".
  Collapsed now, but the general lesson holds: a substitution rule written for
  one syntactic position needs a guard for the others.
- **`findUnresolved` must run on the ORIGINAL script.** Run it after
  substitution and the log fills with the pipeline's own output — every
  generated number word, every lexicon replacement. Bad signal-to-noise from day
  one means nobody reads the log, which kills the only mechanism that makes the
  speech work compound.

## Next

- Verify the 28 val2026 feed URLs.
- Confirm Gemini-TTS Preview access for sv-SE and that the service account has
  `roles/aiplatform.user` — the existing code only requests the
  `cloud-platform` scope, which is not the same thing. This fails at the first
  call, not at deploy.
- Verify the Gemini-TTS voice name form. `voiceId: "Charon"` plus `modelName` is
  the assumption; Chirp wants the full `sv-SE-Chirp3-HD-Charon`. Untested.
- Single-voice reference recording with style prompt and normalization, as the
  baseline to measure dialogue against.
- Riksdagen's open API as val2026's real primary-source layer, after the
  election.
- Entity queue.
- Per-sphere feed quotas. Scoring is per sphere so there is no cross-sphere
  comparability; at five or six spheres the ~25 feed slots need allocating and
  there is no principle for it yet.
- Sphere candidates by fit: EU/Brussels (EUR-Lex, the legislative observatory —
  arguably a better fit than Congress), Swedish state inverted (riksdagen API,
  SOU, remisser), retail (HUI and SCB against consensus), football (odds
  deviation). AI/tech is the worst fit despite being the most tempting: no
  natural arithmetic gate and enormous volume.
