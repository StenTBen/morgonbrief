# Morgonbrief

A daily Swedish audio brief on the US Congress, built for a reader who has already
seen the news. Media coverage decides *what* gets covered; Congress.gov decides
*what is said about it*. The model never scores and never recalls facts — it only
writes prose from documents already in front of it.

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
`firestore.rules`, Publish. Without this the database is closed and the app shows
a permission error.

**5. Run it once by hand.** Actions → Morgonbrief → Run workflow. Read the log
before trusting anything: it prints how many feeds answered, how many headlines
mapped to a bill, every score with its reasons, and which Swedish voice the
project actually has.

Then open the Pages URL on the phone and add it to the home screen.

## What the log tells you

- `Sweep: N items from X/Y feeds` — dead feeds are normal; delete them from
  `spheres/congress.json` rather than debugging them.
- `Linked N legislative candidate(s)` — zero means the day's coverage was politics
  rather than legislation. That is a real answer, not a bug.
- `Scored N, qualified M` — `M` is capped at 2 by design. An empty episode is the
  correct output on a quiet day, and the script says so out loud.

## Tuning

`spheres/congress.json` is the whole editorial policy: which feeds count, what
scoring counts as important, the threshold, and the rules the script must obey.
Raising `threshold` makes episodes rarer and better. Nothing in `scripts/` needs
touching to change what gets covered.

## Deliberately not in v0

- **No learning loop yet.** The app records votes to `feedback`, but nothing reads
  them. Collect a couple of weeks first — with one item or two per day, adjusting
  weights on early noise would lock in randomness.
- **No entity queue.** "Fördjupa imorgon" is stored, not yet acted on.
- **No search sweep.** Adding Brave would let the deep-dive follow a thread beyond
  the documents. Worth doing once the base chain is proven.
- **No second sphere.** Crypto and football come after Congress runs clean for a
  week.

## Rotate the keys

All three keys passed through a chat transcript while this was being built.
Once the pipeline runs reliably, regenerate each one and update the secrets:
DeepSeek platform, api.data.gov, and Firebase → Project settings → Service
accounts.
