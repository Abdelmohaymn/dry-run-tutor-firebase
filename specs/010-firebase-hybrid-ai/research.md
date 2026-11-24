# Research: Firebase Hybrid AI Tutor

Facts checked 2026-11-23 against firebase.google.com/docs/ai-logic, pub.dev,
Google Maven metadata and FlutterFire source. Items marked **VERIFY** were not
confirmed and must be checked at the task that uses them.

## R1. Who calls the model: the step protocol

**Decision**: Every model call (tutor, rewrite, progress check, condense,
evidence checks, judge, transcript repair) is made by the app through Firebase
AI Logic. The relay keeps the whole pipeline but asks for each call through a
stateless step protocol (contracts/relay-steps.md): it returns the calls it
needs; the app runs them and re-POSTs the same request plus the answers; the
relay re-runs the pipeline from the top and either asks for the next calls or
returns the checked result. D1 writes happen only on the final step.

**Rationale**:
- One honest story for judges: "the relay holds no model key and calls no model;
  every Gemini call is Firebase AI Logic, in the app" (FR-001, FR-002).
- The pipeline code (prompts, leak filter, finish check, evidence checks, judge
  post-processing) is reused almost verbatim. Only its orchestration is split
  into stages with barriers.
- Stateless: no D1 rows for in-flight turns, no ground truth stored anywhere new.
- Writes only at commit: an abandoned loop (network drop, app killed) costs no
  turn, so "never counted twice" holds without refunds.

**Alternatives considered**:
- *App makes only the tutor reply and the verdict; the relay makes the side checks
  on its own Gemini key.* Fewer round trips, but two quota pools, a server model
  key, and a muddier README story. Kept as fallback if SC-004 latency fails
  (only `progress`/`evidence`/`condense` would move server-side; the protocol is
  unchanged for `tutor` and `judge`).
- *Replay with "magic" async suspension (never-settling promises + quiescence
  detection).* Clever, hard to debug, fragile with D1 awaits in the middle.
  Rejected for explicit stage barriers.
- *Store step state in D1.* Violates minimal-backend-data; adds cleanup.

**Round trips**: a normal turn = 2 relay POSTs (S2 ask, done) + 1 parallel
Gemini pair. +1 when condensation triggers, +1 when a draft is blocked. Judge =
up to 5 stages, mostly 4.

## R2. Flutter `firebase_ai` for the cloud path

**Decision**: `firebase_ai: ^5.2.0`, `firebase_core: ^5.1.0`,
`firebase_app_check: ^0.5.2`, backend `FirebaseAI.googleAI(appCheck: …,
useLimitedUseAppCheckTokens: true)` (Gemini Developer API, works on Spark).
Non-streaming `generateContent` (the relay must check the whole draft before the
learner sees it, as today — streaming buys nothing).

- `firebase_ai` 5.x needs **Flutter ≥ 3.44, Dart ^3.12**. The repo's `fvm` has
  Flutter 3.44.1 / Dart 3.12.1 (system Flutter is 3.41 — always use `fvm`).
  `pubspec.yaml` `sdk:` goes to `^3.12.0`; CI pins Flutter 3.44.x.
- `vertexAI()` was renamed `agentPlatform()` and needs billing. Do not use it.
- `firebase_auth` is a transitive dependency; Auth is NOT required by AI Logic.
- System instructions, `GenerationConfig(responseMimeType: 'application/json',
  responseSchema: Schema…)`, `ThinkingConfig(thinkingBudget:)`, `Content.model`
  for multi-turn: present in the API. **VERIFY** `ThinkingConfig` name and
  `responseSchema` vs `responseJsonSchema` in 5.2.0 at task time (read the
  package source under `~/.pub-cache`).

**Alternatives**: calling Gemini over REST with an API key from the app —
violates the hackathon rule (must be Firebase AI Logic) and App Check.

## R3. Models and quota

**Decision**: model name per purpose lives in remote config
(`gemini.models`, data-model.md §R3), never compiled into the app
(Constitution X.3). Seed values: **VERIFY** in Firebase console → AI Logic →
models at setup. The models page lists, as billing-free: `gemini-4-hydrogen`
(stable), `gemini-3.8-flash`, `gemini-3.5-flash-lite`. `gemini-2.5-flash` is
re-routed to `gemini-3.5-flash-lite` from 2026-12-01 (inside judging) — do not
seed it.

Seed (to confirm): `tutor`, `rewrite` → the stable flash-class model;
`progress`, `evidence`, `condense`, `repair` → the lite model if the harness
passes on it, else the same as tutor; `judge` → the stable model.

- Free-tier limits are **per project**, shared by all users. Exact RPM/RPD for
  these models were not published in a readable form. **VERIFY** in AI Studio
  rate-limit page for the project.
- AI Logic's per-user limit defaults to 100 RPM. Lower it to 30 RPM (Cloud
  console → Firebase AI Logic API → Quotas): a turn makes ≤ 4 calls, a judge ≤ 5.
- On `429`/quota errors the app falls back to the on-device tutor (US3) or shows
  the existing rate-limit copy.

## R4. Structured output schema

**Decision**: the relay emits a small Gemini-safe subset (contracts/relay-steps.md
§GeminiSchema); `lib/core/ai/schema_converter.dart` maps it 1:1 to `firebase_ai`
`Schema` (`Schema.object(properties:, optionalProperties:)`,
`Schema.array(items:)`, `Schema.enumString(enumValues:)`, `Schema.string(nullable:)` …).
The relay converts its existing JSON Schemas (`buildJudgeSchema`,
`finishCheckSchema`, `evidenceCheckSchema`, repair) with one function
`toGeminiSchema()` that drops `additionalProperties` and turns
`type: ["string","null"]` into `{type:"string", nullable:true}`.

Strictness is lower than OpenAI `strict: true`, so the relay keeps validating:
every existing parser (`parseJudgeOutput`, `postprocessJudge`, `runFinishCheck`)
already tolerates bad output; enum membership is re-checked there. Principle II
holds because the enum is in the schema AND re-checked in code.

Note: `firebase_ai` `Schema.object` treats every property as required unless
listed in `optionalProperties` — the converter passes
`optionalProperties = properties − required`.

## R5. On-device model (Gemini Nano)

**Decision**: native Kotlin, `com.google.firebase:firebase-ai:18.2.0` +
`com.google.firebase:firebase-ai-ondevice:16.0.0-beta08` (pinned explicitly, not
via BoM), `InferenceMode.ONLY_ON_DEVICE`, reached from Dart over a
`MethodChannel` (`app.dryrun/ondevice`, contracts/on-device-channel.md). Same
default `FirebaseApp` that FlutterFire initialises.

- The Flutter plugin has **no** hybrid support (flutterfire#17815 open).
- `minSdk` must rise **24 → 26** for the on-device artifact.
- `FirebaseAIOnDevice.checkStatus()` → `UNAVAILABLE | DOWNLOADABLE | DOWNLOADING
  | AVAILABLE`; `download()` is a Flow; the SDK does **not** download by itself.
  The app starts the download at launch when status is `DOWNLOADABLE` and the
  phone is online (no prompt, US3).
- On-device: single-turn text only, no chat, foreground only
  (`BACKGROUND_USE_BLOCKED`), per-app quota (`BUSY`,
  `PER_APP_BATTERY_USE_QUOTA_EXCEEDED`). So the offline tutor flattens system
  rules + public statement + last few turns into **one prompt string** per turn
  (data-model.md §A4). **VERIFY** whether `systemInstruction` is honoured
  on-device; the flattened prompt works either way.
- Why not `PREFER_IN_CLOUD` with automatic fallback for the online call: the
  fallback would run the online prompt (with ground truth, unchecked by the
  relay) on Nano, breaking FR-009 and the leak filter. Online and offline are
  chosen explicitly by the app instead.
- Kotlin API (from docs; **VERIFY** exact names against the beta08 AAR):
  ```kotlin
  @OptIn(PublicPreviewAPI::class)
  val model = Firebase.ai(backend = GenerativeBackend.googleAI())
      .generativeModel(modelName = "<any cloud model id>",
          onDeviceConfig = OnDeviceConfig(mode = InferenceMode.ONLY_ON_DEVICE,
              maxOutputTokens = 256, temperature = 0.4f))
  ```

**Alternatives**: ML Kit GenAI Prompt API directly (`com.google.mlkit:genai-prompt`)
— it is what firebase-ai-ondevice uses underneath, but calling it directly would
not be "Firebase AI Logic hybrid inference", which judges score.

## R6. App Check for a sideloaded APK

**Decision**: Play Integrity provider in release; in Firebase console set the
app's distribution to **"Exclusively outside Google Play"** (requires only
`MEETS_DEVICE_INTEGRITY`) and register the release signing cert SHA-256. Debug
provider in debug builds only (token from `--dart-define`, never committed).
Enforcement: start in **Monitoring**, flip to **Enforced** only after a
sideloaded release APK is verified on two real phones (quickstart.md §5).
`useLimitedUseAppCheckTokens: true` + replay protection Monitoring.

- Emulators and rooted phones fail `MEETS_DEVICE_INTEGRITY` → the app shows
  "this build can't reach the tutor" (spec edge case). README says so.
- No fixed debug token in the public APK (it would be public).
- **VERIFY** whether Play Console linking is mandatory for an app with no Play
  listing; if Play Integrity cannot work at all without it, fallback is App Check
  Monitoring-only during judging, stated in README (the rule is "uses App Check",
  which Monitoring still satisfies).

## R7. Android application id

**Decision**: keep `applicationId = "app.dryrun.tutor"`. The Firebase Android
app is registered under this id.

**Rationale**: owner decision 2026-11-23 — the Nebius build is not installed on
the owner's phone, so replacing it on install is acceptable.

**Alternatives**: a distinct `app.dryrun.tutor.firebase` id (side-by-side
installs) — rejected by the owner.

## R8. The new relay

**Decision**: same `worker/` code on `firebase-main`; `wrangler.jsonc` loses the
`dev` and `prod` envs and gains one env `firebase` (`name:
dry-run-tutor-firebase`, own D1 `dry-run-tutor-firebase`). Top-level `name` also
becomes `dry-run-tutor-firebase`, so a bare `wrangler deploy` can never hit the
Nebius worker (SC-006). Secrets: `INSTALL_HMAC_SECRET`, `STT_KEY_GROQ` only. No
`TRIAL_KEY_*`.

v1 model routes (`/v1/chat`, `/v1/judge`, `/v1/trial`, `/v1/repair`) are
**unmounted** from `index.ts` at the end (FR-001). Their library code stays (v2
reuses it). Their contract tests are converted to drive the same lib functions
through v2, or deleted when v2 contract tests cover the same behaviour (task-level
call; the leak/judge behaviour tests MUST survive in some form).

STT (`/v1/stt`, Groq Whisper on `STT_KEY_GROQ`) stays as is (FR-014). That is
speech, not tutor or judge text.

## R9. Harness on Gemini (SC-002)

**Decision**: the live harness (`worker/test/harness`) gets a "fake app" client
that drives `/v2/turn` and `/v2/judge` and answers each `ModelCall` by calling
Gemini through the OpenAI-compatible endpoint
(`generativelanguage.googleapis.com/v1beta/openai`, already in
`KEYED_PROVIDER_BASE_URLS`) with `GEMINI_API_KEY` from a dev AI Studio key in the
same or a sibling project. Same model ids as config. It exercises the exact
prompts and schemas the app will send. Script: `npm run test:harness:gemini`.

The OpenAI-compat endpoint accepts JSON Schema `response_format`; the harness
sends the Gemini-subset schema converted back (or the original). Close enough for
prompt regression; the device run (quickstart §4) covers the real SDK path.

## R10. Offline note (FR-011a)

**Decision**: deterministic, no model: the app quotes the learner's offline
turns since the last online turn, newest last, each trimmed to 200 chars, joined
`" / "`, whole note ≤ 600 chars, prefixed by the relay as
`[While offline, the learner said: …]`. "From the learner's own words" is then
literally true, and a Nano summary cannot invent claims.

## R11. Offline reply guard

**Decision**: after Nano answers, the app replaces the reply with a fixed l10n
line ("Keep going — talk me through your approach step by step.") when it is
empty, longer than 600 chars, contains a fenced code block, or contains the
words `correct`, `wrong`, `right answer`, `solution is` (case-insensitive,
English only — the offline tutor is told to reply in the learner's language,
and other-language checks are out of scope). No verdict path exists offline.

## R12. Ground truth stays in memory (FR-006)

**Decision**: `ModelCall`/answers live only inside `StepLoop.run()` locals. Not
in Cubit state, not in Drift, not in the outbox, not logged. `firebase_ai`'s own
logging is off in release. The redacting dio interceptor already drops bodies;
add the `/v2/*` paths to its body-redaction list. A unit test asserts that after
a loop, no Drift table and no outbox row contains a call's `system` text.

## R13. Constitution conflicts

Principle VI (ground truth never leaves the server; one host) and VIII (no
offline tutor) conflict. Amendment 5.0.0 (MAJOR) is owed before merge, made the
same way as 4.0.0: text drafted by `/speckit-constitution`, owner reads and
approves. The plan's Constitution Check records the violations as justified.
