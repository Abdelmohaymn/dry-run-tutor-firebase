# Implementation Plan: Firebase Hybrid AI Tutor

**Branch**: `firebase-main` (spec dir `specs/010-firebase-hybrid-ai`) | **Date**: 2026-11-23 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/010-firebase-hybrid-ai/spec.md`

**Implementer**: Claude Sonnet 5.5. This plan is written to be followed literally:
every decision is made here or in [research.md](research.md); where a fact could
not be confirmed it is marked **VERIFY** with what to check. Do not redesign —
if something here proves impossible, stop and report it.

**Deadline**: submissions close 2026-11-30 14:00 PT. Priority order if time runs
short: Phase 1–3 (online on Gemini) → Phase 4 (offline) → Phase 6 (README/APK)
→ Phase 5 (repair, polish).

## Summary

Move every model call from the relay (Nebius Nemotron) to the app (cloud Gemini
via Flutter `firebase_ai`, App Check on). The relay keeps the pipeline — prompts,
ground truth, turn cap, leak filter, finish check, judge post-processing — and
drives the app through a **stateless step protocol**: it returns the model calls
it needs, the app runs them and re-POSTs with the answers, the relay re-runs and
either asks again or returns the checked result, writing D1 only at the end
([contracts/relay-steps.md](contracts/relay-steps.md)). Offline (or when the cloud
is rate-limited) on Nano-capable phones, an on-device tutor (Gemini Nano via
native `firebase-ai-ondevice`, `ONLY_ON_DEVICE`) answers from the public
statement only, labelled offline, outside the cap and the judge
([contracts/on-device-channel.md](contracts/on-device-channel.md)). New relay
`dry-run-tutor-firebase` with its own D1; Nebius and PayPal relays untouched.

## Technical Context

**Language/Version**: Dart 3.12 / Flutter 3.44.x via `fvm` (app); TypeScript 5.9 on Cloudflare Workers (relay); Kotlin (Android channel)

**Primary Dependencies**: app — `firebase_core ^5.1.0`, `firebase_ai ^5.2.0`, `firebase_app_check ^0.5.2` (new), existing flutter_bloc/get_it/go_router/dio/drift/freezed; Android — `com.google.firebase:firebase-ai:18.2.0`, `com.google.firebase:firebase-ai-ondevice:16.0.0-beta08`, Google Services Gradle plugin; relay — hono, zod (unchanged, no new deps)

**Storage**: D1 `dry-run-tutor-firebase` (fresh; migrations 0001–0013); Drift on device (schema +1: `messages.origin`)

**Testing**: vitest + `@cloudflare/vitest-pool-workers` (relay unit/contract), live harness on Gemini (`test:harness:gemini`), `flutter_test` + `bloc_test` + `mocktail` (app), manual device runs (quickstart.md)

**Target Platform**: Android, minSdk **26** (was 24; required by `firebase-ai-ondevice`), sideloaded APK; Nano on AICore phones only

**Project Type**: mobile app + API relay (existing repo layout)

**Performance Goals**: online turn reply within median + 2 s of the `main` build (SC-004); 3 consecutive offline replies with no error (SC-003)

**Constraints**: Spark free tier only; no billing; no analytics; App Check on every AI Logic call; ground truth only in memory on device (FR-006); Nebius/PayPal relays get zero deploys (SC-006); `firebase-main` never pushed to `origin` or `paypal`

**Scale/Scope**: hackathon judges (tens of users); 4 shipped problems + practice problem

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design (below).*

| Principle | Status | Note |
|---|---|---|
| I Voice-first | PASS | Composer and transcript review unchanged. |
| II Judge classifies against ground truth | PASS | Same prompts; Gemini `responseSchema` carries the problem's own enums AND the relay re-checks them (research.md R4). |
| III Tutor hints, does not solve | PASS | Leak filter + rewrite stay on the relay; the learner never sees an unchecked draft. Offline tutor has no ground truth to leak (FR-009). |
| IV Judge never costs the streak | PASS | Unchanged; offline end still credits. |
| V Transcript editable | PASS | Unchanged. |
| **VI Ground truth never leaves the server; one host** | **VIOLATION (justified)** | Ground truth reaches the app per call, in memory only; the app talks to the relay AND Firebase. Accepted in spec Clarifications. Amendment 5.0.0 owed. |
| VII Audio | PASS | STT unchanged on the new relay. |
| **VIII "There is no offline tutor"** | **VIOLATION (justified)** | This feature adds one. Every "MUST still hold" bullet keeps holding; non-Nano phones behave exactly as today. Amendment 5.0.0 owed. |
| IX Trusted time | PASS | Unchanged. |
| X Free, zero cost | PASS | Spark tier, no payment method: limits produce rate-limit messages, never bills (X.2). Model ids per purpose are server-configurable (X.3). No paywall, no ads change. |
| Locked stack | PASS | New SDKs are not state/DI/router changes. Native channel follows existing `TrustedTimeChannel` pattern. |
| Quality gates: no third-party analytics | PASS | No `firebase_analytics`; analytics collection explicitly deactivated in the manifest (FR-016). |
| Quality gates: tutor/judge harness | PASS | Harness re-pointed at Gemini through v2 (research.md R9). |
| Governance: D7 bar | DECLARED | Justified by hackathon entry, not D7 — stated plainly, as the 4.0.0 amendment did. |

**Gate result**: proceed. The two violations are recorded in Complexity Tracking
and the amendment is task **P0.1**, which must be approved by the owner before
anything merges anywhere (it never merges to `main`; this branch is its own entry).

**Post-design re-check**: unchanged. The design adds no new conflict: D1 gains
only cap-enforcing columns (`last_turn_key`, `last_turn_index`); the relay still
stores no message content; no model key anywhere on the relay.

## Project Structure

### Documentation (this feature)

```text
specs/010-firebase-hybrid-ai/
├── plan.md                      # this file
├── research.md                  # R1–R13 decisions
├── data-model.md                # relay (R*) and app (A*) changes
├── quickstart.md                # validation runbook
├── contracts/
│   ├── relay-steps.md           # /v2/turn, /v2/judge, /v2/repair
│   └── on-device-channel.md     # app.dryrun/ondevice
└── tasks.md                     # /speckit-tasks (not yet)
```

### Source code (new = ★, changed = ✎, unmounted = ✕)

```text
worker/
├── wrangler.jsonc                         ✎ only env "firebase"; name dry-run-tutor-firebase
├── migrations/0013_turn_key.sql           ★
├── src/index.ts                           ✎ mount /v2/*; unmount v1 model routes (last phase)
├── src/routes/v2-turn.ts                  ★
├── src/routes/v2-judge.ts                 ★
├── src/routes/v2-repair.ts                ★
├── src/routes/chat.ts, judge.ts, trial.ts, repair.ts   ✕ (files kept until Phase 3 end, then deleted with their tests if not reused)
├── src/lib/step-port.ts                   ★ StepPort, PendingCall, NeedModel, call ids (FNV-1a 64)
├── src/lib/gemini-schema.ts               ★ toGeminiSchema()
├── src/lib/turn-pipeline.ts               ★ staged tutor turn (S1–S3) reusing chat-core helpers
├── src/lib/judge-pipeline.ts              ★ staged judge (J1–J5) reusing judge-core helpers
├── src/lib/turn-cap.ts                    ✎ planReservation(), commitTurn(), claimJudge unchanged
├── src/lib/runtime-config.ts              ✎ gemini block
├── src/lib/errors.ts                      ✎ STEP_DIVERGED (409)
├── src/routes/config.ts                   ✎ strip gemini
├── test/unit/step-port.test.ts            ★
├── test/unit/gemini-schema.test.ts        ★
├── test/contract/v2-turn.test.ts          ★ ports the behaviour cases of chat/trial contract tests
├── test/contract/v2-judge.test.ts         ★ ports judge contract cases
├── test/contract/v2-repair.test.ts        ★
└── test/harness/lib/gemini-app-client.ts  ★ fake app: answers ModelCalls via Gemini OpenAI-compat

lib/
├── main.dart                              ✎ Firebase.initializeApp + AppCheck.activate before setupLocator
├── firebase_options.dart                  ★ flutterfire configure (committed; ids are not secrets)
├── core/ai/model_gateway.dart             ★ interface: Future<ModelAnswer> run(ModelCallDto)
├── core/ai/firebase_model_gateway.dart    ★ firebase_ai implementation, timeouts, error mapping
├── core/ai/schema_converter.dart          ★ GeminiSchema JSON → firebase_ai Schema
├── core/ai/on_device_model.dart           ★ interface + ChannelOnDeviceModel
├── core/ai/on_device_model_service.dart   ★ status cache, auto-download when online
├── core/network/relay_client.dart         ✎ turnStep/judgeStep/repairStep; remove chat/trial/judge/repair calls at the end
├── core/network/dto/step_dto.dart         ★
├── core/network/redacting_log_interceptor.dart  ✎ redact /v2/* bodies
├── core/config/relay.dart                 ✎ default https://dry-run-tutor-firebase.<subdomain>.workers.dev (VERIFY subdomain)
├── core/db/tables.dart, app_database.dart ✎ messages.origin, schemaVersion +1
├── features/chat/data/step_loop.dart      ★ the POST→calls→POST loop (shared by turn/judge/repair)
├── features/chat/data/offline_prompt.dart ★
├── features/chat/data/offline_tutor.dart  ★ prompt → OnDeviceModel → guard (R11) → rows
├── features/chat/data/session_repository_impl.dart  ✎ route table data-model.md §A7
├── features/chat/domain/turn_event.dart   ✎ offlineReply variant
├── features/chat/presentation/…           ✎ offline label on bubbles, cubit handles offlineReply
├── features/assessment/data/assessment_repository_impl.dart  ✎ judge via StepLoop
├── features/voice/… (repair caller)       ✎ repair via StepLoop
├── features/keys/…, settings             ✎ hide BYOK entry points (FR-015); Settings row "Offline tutor: Ready / Downloading / Not supported"
└── l10n/app_en.arb (+ other ARBs)        ✎ offline label, downloading, busy, app-check copy, offline fixed line

android/
├── settings.gradle.kts                    ✎ com.google.gms.google-services plugin
├── app/build.gradle.kts                   ✎ applicationId unchanged (app.dryrun.tutor), minSdk 26, firebase-ai + ondevice deps
├── app/google-services.json               ★
├── app/src/main/AndroidManifest.xml       ✎ firebase_analytics_collection_deactivated=true
└── app/src/main/kotlin/app/dryrun/OnDeviceModelChannel.kt  ★ (+ MainActivity ✎)

README.md                                  ✎ "How it uses Firebase AI Logic" section (FR-017)
.github/workflows/*                        ✎ Flutter 3.44.x; worker deploy job (if any) must not target dry-run-tutor
```

**Structure Decision**: existing mobile app + `worker/` relay layout, unchanged. The
new relay is a deployment env of the same `worker/` code on this branch.

## Implementation phases

Each phase ends green (`npm test` in `worker/`, `fvm flutter analyze && fvm flutter test`).
Commit per phase on `firebase-main`. Never `git push origin` / `git push paypal`.

### Phase 0 — Guard rails (½ h)

- **P0.1** Constitution amendment 5.0.0 draft via `/speckit-constitution` (VI:
  ground truth may reach the app per call, in memory only, on the Firebase entry;
  "one host" → relay + Firebase AI Logic. VIII: an on-device offline tutor
  exists on supported phones; offline turns are outside the cap and the judge).
  Owner approves before merge.
- **P0.2** `wrangler.jsonc`: replace `dev`/`prod` envs with one `firebase` env;
  top-level `name: dry-run-tutor-firebase`. Check `.github/workflows` for any
  deploy job and point it at `--env firebase` or remove it.
- **P0.3** Pin Flutter with fvm: `fvm install 3.44.1` (skips the download if cached) then `fvm use 3.44.1`, so `.fvmrc` reads `"flutter": "3.44.1"` instead of the moving `"stable"` and the version stays on this machine for later. `pubspec.yaml` `sdk: ^3.12.0`; CI Flutter 3.44.1.

### Phase 1 — Relay step protocol (core; ~1 day)

Read first: `worker/src/lib/chat-core.ts`, `judge-core.ts`, `finish-check.ts`,
`judge-evidence.ts`, `condense.ts`, `turn-cap.ts`, `routes/trial.ts`.

1. `step-port.ts` + unit tests: id determinism, pending/barrier, `unused()`,
   error answers → `AppError`, `asProvider`/`asStructuredCall` adapters.
2. `gemini-schema.ts` + test: every schema from `buildJudgeSchema`,
   `finishCheckSchema`, `evidenceCheckSchema`, repair schema, for every shipped
   problem, converts and contains only allowed keywords.
3. `turn-cap.ts`: `planReservation`, `commitTurn` (data-model.md §R1), migration 0013.
4. `turn-pipeline.ts`: `runTurnSteps(input, counters, port, cfg, problem)` → `{kind:"need", calls} | {kind:"done", reply, outcome}`.
   Mirror `runConversationalTurn` line by line: S1 condense → barrier → build
   prompt (same `TUTOR_PROMPT` replacements, `withReplyLanguageNote`,
   `withSolutionReleaseNote`, plus the `offline_note` line inserted right after
   the summary line) → S2 tutor ∥ progress → barrier → filter / early unblock →
   S3 rewrite if needed → barrier → result. No D1 access inside; counters come in,
   writes go out as `outcome` for the route to commit.
   Ground-truth tier: `"AB"`. Practice problem: cap `trial.practice_turn_cap`,
   condense off (as v1 practice).
5. `routes/v2-turn.ts`: parse, guards (as v1 `chat.ts`), read counters, plan,
   run pipeline; on `need` → 200 `{status:"model"}`; on `done` → `commitTurn`,
   record keys, build `MetaFramePayload` exactly as v1, 200.
6. `judge-pipeline.ts` + `routes/v2-judge.ts`: mirror `runJudge`: J1…J5,
   `assertNotJudged` read-only up front, `claimJudge` only at commit. The second
   judge ask has `attempt: 2` in its call so its id differs.
7. Contract tests `v2-turn`, `v2-judge`: port the behavioural cases from the v1
   chat/trial/judge contract tests (leak rewrite, clean lead, fallback, early
   unblock, cap, solution release, hint branch, judged-session refusal,
   condense summary/summary_covers, finish offer). Fake "app" in tests answers
   from fixtures, like the v1 tests' fake provider.

### Phase 2 — App online path on Gemini (~1 day)

1. Firebase setup (quickstart §0, owner does console parts), deps, Gradle,
   `minSdk 26`, manifest analytics off.
2. `main.dart`: `Firebase.initializeApp(options: DefaultFirebaseOptions.currentPlatform)`;
   `FirebaseAppCheck.instance.activate(androidProvider: kReleaseMode ? AndroidProvider.playIntegrity : AndroidProvider.debug)`
   (**VERIFY** 0.5.x API name — it may be `providerAndroid: AndroidPlayIntegrityProvider()`; read the package source).
3. `schema_converter.dart` + tests; `firebase_model_gateway.dart`: build
   `GenerativeModel` per call (model, systemInstruction, generationConfig with
   maxOutputTokens/temperature/thinking/responseSchema); map
   `FirebaseAIException`/quota/`ServerException` → `rate_limited | unavailable |
   blocked | other`; App Check failure → distinct error type for the
   "can't reach the tutor" copy; timeout from `timeout_ms`.
4. `step_dto.dart`, `RelayClient.turnStep/judgeStep/repairStep`.
5. `step_loop.dart`: `Future<Map<String,Object?>> run(post, gateway)`:
   POST → `model` → run calls in parallel (`Future.wait`) → required failure ⇒
   throw `ModelCallFailed(error)` → POST again … ≤ 6 POSTs; `STEP_DIVERGED` ⇒
   one restart. Unit tests with fake relay + fake gateway.
6. `SessionRepositoryImpl.sendTurn` / `pullHint` / judge / repair callers use
   the loop. Yield `token(reply)` then `meta(counters)` exactly like today, so
   the Cubit is untouched for the online path. Outbox replay goes through the
   same loop.
7. Every session is `SessionPath.trial` (no key); hide BYOK UI (FR-015).
8. `relay.dart` default URL → the new worker.
9. `test/security/no_ground_truth_persisted_test.dart` (research.md R12); update
   `host_allowlist_test` docs (dio still relay-only; Firebase uses its own client).

### Phase 3 — Harness, switch-off, first device run (½ day)

1. `gemini-app-client.ts` + `test:harness:gemini` script; run, record pass
   rates vs Nemotron baseline (SC-002). Tune only config (model ids, thinking,
   temperature) — prompt edits need the owner.
2. Unmount v1 `/v1/chat`, `/v1/judge`, `/v1/trial`, `/v1/repair`; delete their
   routes and contract tests once v2 tests cover them; remove dead app calls.
3. Deploy `--env firebase`; quickstart §4 on a real phone.

### Phase 4 — Offline tutor (~1 day)

1. `OnDeviceModelChannel.kt` + `MainActivity` registration (contract). **VERIFY**
   class names against the beta08 AAR (`~/.gradle/caches`, or javap the jar):
   `FirebaseAIOnDevice`, `OnDeviceConfig`, `InferenceMode`, download Flow types.
2. `on_device_model.dart`, `on_device_model_service.dart` (status at launch/resume;
   start download when `downloadable` and online).
3. Drift `origin` column + migration test; request builders exclude offline rows;
   `offlineNote()`; relay `offline_note` already in Phase 1.
4. `offline_prompt.dart`, `offline_tutor.dart` (guard R11), `TurnEvent.offlineReply`,
   Cubit handling, bubble label, l10n.
5. Route table data-model.md §A7 in `sendTurn`. Debug-only Settings toggle
   "Simulate cloud rate limit" (gateway answers `rate_limited` for `tutor`) for US3
   testing; compiled out of release (`kDebugMode`).
6. Quickstart §5 on a Nano phone.

### Phase 5 — Polish (as time allows)

Settings "Offline tutor" row; App Check failure copy; edge-case copy (downloading,
busy); latency check SC-004; per-user quota 30 RPM.

### Phase 6 — Submission (½ day, must not slip)

README "How it uses Firebase AI Logic" (cloud: tutor, judge, checks; device:
offline tutor; App Check; how to see offline mode; what non-Nano phones show),
LICENSE present (MIT), signed release APK, quickstart §6, flip App Check to
Enforced only if §6 passes, demo video. Public repo `dry-run-tutor-firebase`
created **only** when the owner says "submitting" (memory: firebase-entry-branch).

## Implementer notes (Sonnet 5.5)

- **Do not invent API names.** Three SDKs here are new or beta (`firebase_ai` 5.2,
  `firebase_app_check` 0.5, `firebase-ai-ondevice` beta08). Before writing code
  against one, open its source in `~/.pub-cache/hosted/pub.dev/<pkg>-<ver>/lib`
  or the Gradle cache and match the real signatures.
- **Mirror, don't rewrite** the relay pipeline. The v2 pipelines must produce the
  same prompts byte for byte as v1 for the same inputs (add a unit test that
  builds the S2 tutor `system` via v2 and via the v1 code path for one fixture).
- **Barrier after every stage.** Reused helpers swallow errors and return `null`;
  a `null` before `port.barrier()` means "not answered yet", not "failed".
- **No D1 write before `done`.** Contract test asserts row equality before/after
  a `status: model` step.
- **Ground truth never persisted on device.** No `ModelCall` field in Cubit state,
  Drift, outbox, logs. No `print`/`debugPrint` of prompts, even in debug.
- **Never deploy to `dry-run-tutor`** or the PayPal worker. Always `--env firebase`.
- **Never push** `firebase-main` to `origin` or `paypal`.
- Use `fvm flutter` / `fvm dart` only, never the system `flutter` (3.41). If `fvm list` lacks 3.44.1, `fvm install 3.44.1`.
- Strict analyzer, zero warnings; regenerate freezed/drift code after model edits.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| Principle VI: ground truth sent to the app per call | Hackathon rule: the app must call Firebase AI Logic itself; the cloud model needs the instructions | Relay-side Gemini key: fails the "AI Logic called from shipped code" baseline for tutor/judge; app-built prompts: would bundle ground truth in the APK (worse) |
| Principle VI: app talks to a second host (Firebase) | Same rule | None exists — AI Logic is the required host |
| Principle VIII: an offline tutor exists | Hybrid inference is the top judging criterion; removes the stated offline weakness | No offline tutor: forfeits the hybrid criterion |
| Step protocol (multi-round relay calls) | Keeps prompts, leak filter and judge logic server-side while the app calls the model | Moving the pipeline into the app: ships ground truth + filter logic in the APK and duplicates tested TypeScript in Dart |
| Native Kotlin channel for Nano | Flutter `firebase_ai` has no hybrid support (flutterfire#17815) | Waiting for the plugin: not before the deadline |
