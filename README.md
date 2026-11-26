# Dry Run

A coding-interview problem, talked through out loud with a tutor that already knows the answer
and will not hand it over.

You speak your approach. It pushes back — a counter-question, then a failing case, then the
smallest useful hint. It never says "correct". At the end you get a verdict classified against
human-authored ground truth, and the editorial.

There is **no code entry, no multiple choice, and no tap-to-answer control anywhere in the
product** — one content type, spoken. That constraint is the product, not an omission; see
Principle I in `.specify/memory/constitution.md`.

Built for the **Firebase #BuildHybridAI** hackathon. Every model call is made **from the app
through Firebase AI Logic**: cloud Gemini when online, and **Gemini Nano on the phone** when the
phone is offline or the cloud model is rate-limited.

## For judges

| | |
|---|---|
| Android APK | [Latest release](https://github.com/Abdelmohaymn/dry-run-tutor-firebase/releases/latest): `dry-run-firebase-1.0.0-arm64.apk` (24 MB) for almost every phone; `-armv7.apk` only for old 32-bit phones |
| Demo video | https://youtu.be/Ruwn6CVef2U (2:57) |

Android phones only. **No API key, account or payment needed**, and no daily limit: you can redo a
problem or pick another as often as you like. Install the APK (allow installs from unknown
sources when Android asks), skip or finish the short welcome walkthrough, tap the mic and talk
through your approach (English). When you are done, tap **End session**, then **Finish**, for
your assessment ("How it went") and the full write-up.

**If you see a "busy" or "try again" message**: the cloud model runs on Gemini's free tier,
shared by everyone testing the app. Wait about a minute and send again; your words are kept.

### See the offline tutor

1. Open a problem and have one normal turn, so the model download can start (it needs Wi-Fi or
   mobile data once; Settings → **Offline tutor** says **Ready** when it is on the phone).
2. Turn on **airplane mode** and say another turn.
3. The reply is labelled **Offline tutor**. It asks one question about your approach, never says
   "correct", and does not count towards your turn limit or your assessment.

**On a phone without Gemini Nano** Settings shows *Offline tutor: Not supported on this phone*,
and offline turns behave as they always did: your words are kept and sent when you are back
online. Nano needs a supported phone (Pixel 9 and later, recent Galaxy S and a few others, Android
8+ with AICore).

**App Check and the APK**: the release APK is installed outside Google Play, and Play Integrity
rejects any build Play did not install ("App attestation failed"). So the judging APK attests with
App Check's debug provider and a token registered in the Firebase console, built in at compile
time and never committed. App Check is still enforced on every Firebase AI Logic call; the token
is revoked after judging.

## How it uses Firebase AI Logic

| Where | Model | What it does |
|---|---|---|
| Cloud, called from the app with `firebase_ai`, App Check on | Gemini Flash-Lite (`gemini-3.5-flash-lite`, free tier) | Tutor replies, the judge and its evidence check, condensing long history, transcript repair |
| On the phone, `firebase-ai-ondevice`, `ONLY_ON_DEVICE` | Gemini Nano | The offline tutor: one short question about your approach, from the public problem statement only. It has no answer to leak and gives no verdict |
| The relay (Cloudflare Worker) | none | Holds the prompts and each problem's private half, enforces the turn cap, filters leaks, post-processes the judge. It holds no model key and calls no model |

**The model is configuration, not code.** The model per purpose, timeouts, temperature and
thinking budget live in the relay's database and reach the app with each call. Switching models
(during testing a preview model returned "high demand" errors and another hit its free-tier
limit) is one database update, with no new APK.

**How a turn works.** The relay still runs the whole tutor and judge pipeline, but it cannot call
a model. When it needs one it answers `status: model` with the calls it wants made; the app runs
them through Firebase AI Logic and posts the same request again with the answers. The relay
re-runs, checks the draft (leak filter, one rewrite if a forbidden word slipped in) and either
asks again or returns the finished reply. It keeps no state between steps and writes to its
database only on the last one (`specs/010-firebase-hybrid-ai/contracts/relay-steps.md`).

**What changed from the original design, said plainly.** A problem's private half used to stay on
the server. To let the app call Firebase AI Logic itself, ground truth now reaches the app inside
a model call's instructions, one call at a time, held in memory only: never stored, logged or
bundled in the APK, and never shown to you (you see only the relay's checked reply). And "there
is no offline tutor" no longer holds on phones that support Gemini Nano. Both are recorded as
constitution amendment 5.0.0 (`.specify/memory/constitution.md`).

Speech-to-text runs on **Groq Whisper** (`whisper-large-v3-turbo`); when the daily voice quota
runs out, the phone's own speech recognition takes over.

## Architecture

```
Android app (Flutter) ──HTTPS──▶ Cloudflare Worker relay   (prompts, ground truth, turn cap,
  │  transcripts, sessions,                                  leak filter, judge post-processing)
  │  streak: on the phone only
  ├── firebase_ai + App Check ──▶ Gemini (cloud)           runs the model calls the relay asks for
  └── Kotlin channel ──────────▶ Gemini Nano (on device)   offline tutor, public statement only
```

- **Learner data stays on the phone** (SQLite via Drift). The relay's D1 database holds only what
  enforces usage caps; transcripts, audio and keys are never stored.
- **Firebase Analytics is off** (collection is disabled in the manifest). App Check is on for every
  AI Logic call.
- **No keys anywhere**: the app has no provider-key entry, and neither the app nor the relay holds
  a model key.

## Built for this hackathon

Branch `firebase-main` is a Firebase entry built on an existing Android app. The new work, in
order of `git log`:

- The step protocol and its three routes (`/v2/turn`, `/v2/judge`, `/v2/repair`), with the old
  model routes removed
- Firebase AI Logic from the app (`lib/core/ai/`), App Check, and a loop that runs the relay's
  model calls
- The on-device tutor (`android/.../OnDeviceModelChannel.kt`, `lib/features/chat/data/offline_*`),
  its label, its download, and the fall-back when the cloud is rate-limited
- A live regression harness that drives the whole step loop against Gemini
  (`cd worker && GEMINI_API_KEY=… npm run test:harness:gemini`)

## Layout

| Path | What lives there |
|---|---|
| `lib/` | The Flutter Android client |
| `worker/` | The Cloudflare Worker relay (Hono, D1) |
| `worker/src/prompts/` | Tutor, judge, progress check (`finish-check.ts`), evidence check, condense and repair prompts |
| `content/problems/` | Four sample problems, `public`/`private` split. The live app serves more; they are kept out of the repo so their answers stay private |
| `specs/` | Wire and design contracts the code and tests read |

## Running it

```bash
fvm flutter pub get
fvm flutter run
```

One app (`app.dryrun.tutor`), one relay: `lib/core/config/relay.dart` holds the deployed worker URL.
Pass `--dart-define=RELAY_BASE_URL=https://...` to point a build at another worker. Use `fvm flutter`
(Flutter 3.44.1, pinned in `.fvmrc`). Debug builds need an App Check debug token:
`--dart-define=APP_CHECK_DEBUG_TOKEN=...` (register it in the Firebase console; never commit it).
`lib/core/config/brand.dart` holds the product name and every identifier derived from it.
Release builds use `android/key.properties` if present, otherwise the debug key. A release build
given `APP_CHECK_DEBUG_TOKEN` uses the debug provider (this is how the judging APK is built, since
it is sideloaded); without it, a release build attests with Play Integrity.

## Tests

```bash
fvm flutter analyze             # zero issues is the bar
fvm flutter test
cd worker && npm test
```

If Drift tests fail on `libsqlite3.so`, the host is missing the unversioned dev symlink rather
than the library:

```bash
mkdir -p /tmp/shim && ln -sfn /usr/lib/x86_64-linux-gnu/libsqlite3.so.0 /tmp/shim/libsqlite3.so
LD_LIBRARY_PATH=/tmp/shim fvm flutter test
```

## Deploying the relay

The Firebase relay is its own Worker (`dry-run-tutor-firebase`) with its own database; it never
shares a deploy target with any other build. See `worker/README.md` → *Firebase relay*.

## License

MIT, see `LICENSE`.
