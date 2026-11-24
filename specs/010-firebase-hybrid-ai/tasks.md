---
description: "Task list for the Firebase Hybrid AI Tutor (feature 010)"
---

# Tasks: Firebase Hybrid AI Tutor

**Input**: `specs/010-firebase-hybrid-ai/` — plan.md, spec.md, research.md, data-model.md, contracts/relay-steps.md, contracts/on-device-channel.md, quickstart.md

**Implementer**: Claude Sonnet 5.5. Read plan.md §"Implementer notes" before T001. Every task names its files; decisions live in research.md (R1–R13) and data-model.md (§R1–R3, §A1–A7) — follow them, don't redesign. Where a task says **VERIFY**, open the real package source before writing code against it.

**Tests**: included. The constitution's Quality Gates require the tutor/judge harness, and plan.md requires contract tests for v2.

**Branch rules**: work on `firebase-main`; commit after each phase; never `git push origin` or `git push paypal`; never `wrangler deploy` without `--env firebase`. Use `fvm flutter` / `fvm dart` only.

**Checks**: "relay green" = `cd worker && npm run typecheck && npm test`. "app green" = `fvm dart run build_runner build --delete-conflicting-outputs && fvm flutter analyze && fvm flutter test`.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: US1–US4 from spec.md

---

## Phase 1: Setup

**Purpose**: guard rails and toolchain. No behaviour change.

- [X] T001 Pin Flutter: run `fvm install 3.44.1` (no-op if cached) then `fvm use 3.44.1`; confirm `.fvmrc` reads `{"flutter": "3.44.1"}`; set `environment.sdk: ^3.12.0` in `pubspec.yaml`; run "app green" to prove the bump alone breaks nothing
- [X] T002 [P] Pin Flutter 3.44.1 in `.github/workflows/app.yml` (replace any `stable`/older version input)
- [X] T003 [P] Rewrite `worker/wrangler.jsonc`: top-level `"name": "dry-run-tutor-firebase"`; delete the `dev` and `prod` envs; add one env `firebase` (`name: dry-run-tutor-firebase`, `vars.ENVIRONMENT: "prod"`, D1 binding `DB` → `database_name: dry-run-tutor-firebase`, `database_id: "00000000-0000-0000-0000-000000000000"` placeholder with a comment "owner pastes id from `wrangler d1 create`", same `ratelimits` block); update the secrets comment to list only `INSTALL_HMAC_SECRET`, `STT_KEY_GROQ`, `TURNSTILE_SECRET`
- [X] T004 [P] In `.github/workflows/worker.yml`, remove or retarget any deploy step so nothing can deploy to `dry-run-tutor` (if a deploy job exists, make it `--env firebase` and manual-only via `workflow_dispatch`)
- [X] T005 [P] Draft constitution amendment 5.0.0 with `/speckit-constitution` in `.specify/memory/constitution.md` (Principle VI: on the Firebase entry, ground truth may reach the app per model call, held in memory only, never persisted or bundled; the app talks to the relay and Firebase AI Logic. Principle VIII: on supported phones an on-device offline tutor exists; it has no ground truth, gives no verdict, and its turns are outside the cap and the judge; everything else in VIII still holds. Occasion stated plainly: Firebase hackathon entry, users are the judges). Mark "pending owner read" in the Sync Impact Report like 4.0.0. STOP and tell the owner it needs approval; continue with other tasks meanwhile

**Checkpoint**: relay green, app green.

---

## Phase 2: Foundational (blocks every story)

**Purpose**: the step-protocol machinery on both sides, Firebase in the app. Contract: `contracts/relay-steps.md`.

### Relay

- [X] T006 [P] Add error code `STEP_DIVERGED` (HTTP 409, retryable: false, message "The turn changed while it was being answered.") to `worker/src/lib/errors.ts`, following the existing code table
- [X] T007 [P] Add the `gemini` block (data-model.md §R3) to the zod schema in `worker/src/lib/runtime-config.ts` (required; per-purpose maps with a `default` key where shown; `timeout_ms.progress` falls back to `finish_offer.timeout_ms`), export a helper `geminiCallOpts(cfg, purpose)` returning `{model, thinking_budget, timeout_ms, temperature, max_output_tokens}`; strip `gemini` from the public projection in `worker/src/routes/config.ts`; update config fixtures in `worker/test/fixtures/` and `worker/test/contract/helpers.ts` so every test config has a `gemini` block with model `"test-model"`
- [X] T008 [P] Create `worker/src/lib/gemini-schema.ts`: `toGeminiSchema(jsonSchema)` per research.md R4 (drop `additionalProperties`; `type: [X, "null"]` → `{type: X, nullable: true}`; keep only `type, properties, required, items, enum, nullable`; throw on anything else). Test in `worker/test/unit/gemini-schema.test.ts`: for every problem in content, convert `buildJudgeSchema`, `finishCheckSchema`, `evidenceCheckSchema` output and assert only allowed keys appear at any depth
- [X] T009 Create `worker/src/lib/step-port.ts` per data-model.md §R2: types `Purpose`, `ModelCall`, `ModelAnswer`, `Answers`; `callId(callWithoutId)` = `"c_"` + FNV-1a 64-bit hex (16 chars) of canonical JSON (keys sorted recursively) — synchronous, no `crypto.subtle`; class `StepPort(answers, cfg)` with `text(purpose, system, messages, extra?)`, `json(purpose, system, userContent, jsonSchema, extra?)` (converts via `toGeminiSchema`, maps role `tutor`→`model`), `asProvider(purpose)` (implements `structuredCompletion` of `Provider` in `lib/provider.ts`: with `jsonSchema` → `json`, without → `text`; `streamChat` throws), `asStructuredCall(purpose)` (the `(system, user, schema) => Promise<{result, providerId, model}>` shape used by `runFinishCheck`/`verifySettled`/`gatherEvidence`), `barrier()` (throws `NeedModel(calls)` when pending is non-empty, then clears), `unused()`; unanswered call → record pending + throw `PendingCall`; `{error}` answer → throw `AppError("UNCLEAR_RETRY")`; `required` is set by the caller via `extra.required` (default false). `extra.attempt` is included in the id's canonical JSON
- [X] T010 Unit test `worker/test/unit/step-port.test.ts`: same inputs → same id; different `attempt` → different id; unanswered → pending then `barrier()` throws `NeedModel` with all pending calls of that stage; answered text/json returned; error answer throws `AppError`; `unused()` lists unknown ids; `asProvider` with and without schema
- [X] T011 Create migration `worker/migrations/0013_turn_key.sql` adding `last_turn_key TEXT` and `last_turn_index INTEGER` to `device_day`
- [X] T012 In `worker/src/lib/turn-cap.ts` add `readCounters`-based pure `planReservation(counters, cap, claimedSolutionRequests)` (same arithmetic as `reserveTurn`, incl. `MAX_SOLUTION_REQUEST_INCREMENT` clamp, `turnIndex = turns + 1`, throws `TURN_CAP_REACHED` when `turnIndex > cap`) and `commitTurn(db, key, cap, claimedSolutionRequests, turnKey, plannedTurnIndex)` per data-model.md §R1 (idempotent on `last_turn_key`; one atomic statement guarded by `turns = plannedTurnIndex - 1` and `turns < cap`; no row → re-read and decide `TURN_CAP_REACHED` vs `STEP_DIVERGED`). Keep `reserveTurn` unchanged for now
- [X] T013 Extend `worker/test/unit/turn-cap.test.ts` (or create it if the file is elsewhere — `grep -rl reserveTurn worker/test`): `planReservation` equals `reserveTurn` for every existing case; `commitTurn` twice with the same `turn_key` → `turns` +1 once and same `turnIndex` both times; wrong planned index → `STEP_DIVERGED` and no write; at cap → `TURN_CAP_REACHED` and no write

### App

- [X] T014 Owner step (ask the owner if not done): Firebase console setup from quickstart.md §0 steps 1–4 for app id `app.dryrun.tutor`; then run `fvm dart pub global activate flutterfire_cli` and `flutterfire configure` to create `lib/firebase_options.dart` and `android/app/google-services.json`; record the billing-free model ids the console lists in `specs/010-firebase-hybrid-ai/research.md` R3
- [X] T015 Add `firebase_core: ^5.1.0`, `firebase_ai: ^5.2.0`, `firebase_app_check: ^0.5.2` to `pubspec.yaml`; `fvm flutter pub get`
- [X] T016 Android build: in `android/settings.gradle.kts` add plugin `com.google.gms.google-services` (latest 4.4.x, `apply false`); in `android/app/build.gradle.kts` apply it, set `minSdk = 26` (update the comment: required by firebase-ai-ondevice), keep `applicationId = "app.dryrun.tutor"`, add dependencies `implementation("com.google.firebase:firebase-ai:18.2.0")` and `implementation("com.google.firebase:firebase-ai-ondevice:16.0.0-beta08")` (pinned, not via BoM — research.md R5); in `android/app/src/main/AndroidManifest.xml` add `<meta-data android:name="firebase_analytics_collection_deactivated" android:value="true"/>` (FR-016). Build `fvm flutter build apk --debug` to prove it resolves
- [X] T017 In `lib/main.dart`, before `setupLocator()`: `await Firebase.initializeApp(options: DefaultFirebaseOptions.currentPlatform)`, then activate App Check — Play Integrity when `kReleaseMode`, debug provider otherwise with token from `String.fromEnvironment('APP_CHECK_DEBUG_TOKEN')` when non-empty. **VERIFY** the 0.5.x activate signature in `~/.pub-cache/hosted/pub.dev/firebase_app_check-0.5.*/lib/`
- [X] T018 [P] Create `lib/core/network/dto/step_dto.dart` (freezed + json_serializable, snake_case keys): `ModelCallDto` (all fields of contracts/relay-steps.md §ModelCall), `ModelOutputDto` (`kind`, optional `schema` as `Map<String, dynamic>`), `StepResponseDto` parsed by hand: `status == "model"` → `calls`, `status == "done"` → raw map
- [X] T019 [P] Create `lib/core/ai/model_gateway.dart`: sealed `ModelAnswer` (`text(String)`, `json(Object?)`, `error(ModelErrorKind)`) with `toJson()` per contract; `enum ModelErrorKind { rateLimited, unavailable, timeout, blocked, badOutput, appCheck, other }` (`appCheck` never sent to the relay — it aborts the loop); `abstract interface class ModelGateway { Future<ModelAnswer> run(ModelCallDto call); }`
- [X] T020 [P] Create `lib/core/ai/schema_converter.dart`: `Schema toFirebaseSchema(Map<String, dynamic>)` for the subset in contracts/relay-steps.md (object → `Schema.object(properties:, optionalProperties: properties − required)`, array, string with `enum` → `Schema.enumString`, number, integer, boolean, `nullable`). **VERIFY** constructors in `~/.pub-cache/hosted/pub.dev/firebase_ai-5.2.*/lib/src/schema.dart`. Test `test/unit/schema_converter_test.dart` with the judge-schema shape (copy one emitted by T008 as a fixture JSON in `test/fixtures/`)
- [X] T021 Create `lib/core/ai/firebase_model_gateway.dart` implementing `ModelGateway`: `FirebaseAI.googleAI(appCheck: FirebaseAppCheck.instance, useLimitedUseAppCheckTokens: true)`; per call build `generativeModel(model: call.model, systemInstruction: Content.system(call.system), generationConfig: GenerationConfig(maxOutputTokens, temperature, responseMimeType/responseSchema for json, thinking config when `thinking_budget != null`))`; history → `Content.text` (user) / `Content.model([TextPart])`; `generateContent(...).timeout(Duration(milliseconds: call.timeoutMs))`; map exceptions: quota/429 → `rateLimited`, 503/server/network → `unavailable`, `TimeoutException` → `timeout`, safety/empty candidate → `blocked`, json decode failure → `badOutput`, App Check token failure → `appCheck`, else `other`. No logging of any call field or reply. **VERIFY** exception class names and `ThinkingConfig` in the package source
- [X] T022 [P] Add `turnStep`, `judgeStep`, `repairStep` to `lib/core/network/relay_client.dart` (POST `/v2/turn`, `/v2/judge`, `/v2/repair` with `X-Install-Id`, JSON body `{turn_key?, request, answers}`, return `StepResponseDto`; errors through the existing `_postJson` mapping; add `STEP_DIVERGED` to `lib/core/errors/relay_error_mapper.dart` and its `RelayError` union). Add `/v2/` to the body-redaction rule in `lib/core/network/redacting_log_interceptor.dart`
- [X] T023 Create `lib/features/chat/data/step_loop.dart`: `class StepLoop { StepLoop(this._gateway); Future<Map<String, Object?>> run(Future<StepResponseDto> Function(Map<String, Object?> answers) post) }` — answers start `{}`; on `model` run all calls with `Future.wait`; a failed `required` call (or any `appCheck`) throws `ModelCallFailed(kind, purpose)`; optional failures become error answers; max 6 POSTs then throw `RelayException(RelayError.unclearRetry)` (use the existing variant name); `STEP_DIVERGED` → restart once with `{}`. Calls/answers are locals only (research.md R12). Test `test/unit/step_loop_test.dart` with a scripted fake post + `test/fakes/fake_model_gateway.dart` (create): two-stage success, required failure, optional failure → error answer sent, divergence restart, 6-POST cap
- [X] T024 Register `FirebaseModelGateway` (as `ModelGateway`) and `StepLoop` in `setupLocator()` (find it with `grep -rn "void setupLocator" lib`); inject via constructors only

**Checkpoint**: relay green, app green. Nothing calls v2 yet.

---

## Phase 3: User Story 1 — Online session on cloud Gemini (P1) 🎯 MVP

**Goal**: every online tutor reply and verdict comes from cloud Gemini via Firebase AI Logic; the relay supplies prompts and checks replies; outcomes as today.

**Independent test**: quickstart.md §1, §2, §4.

### Relay: turn

- [X] T025 [US1] Create `worker/src/lib/turn-pipeline.ts`: `runTurnSteps(input: {body, problem, cfg, counters, planned, released, sessionEnded, turnsRemaining, offlineNote?}, port): Promise<TurnStepResult>` mirroring `runConversationalTurn` in `worker/src/lib/chat-core.ts` line by line (plan.md Phase 1 step 4): S1 `condense(...)` with `port.asProvider("condense")` when the condense path would run → `port.barrier()`; build `systemPrompt`/`providerMessages` exactly as v1, inserting `{role:"user", text:"[While offline, the learner said: <note>]"}` right after the summary line when `offlineNote` is set; S2 `Promise.allSettled([port.text("tutor", systemPrompt, providerMessages, {required:true}), runFinishCheck(problem, learnerHistory, port.asStructuredCall("progress"))])` (progress only under v1's conditions) → `port.barrier()`; blocked-term logic and early unblock as v1; S3 rewrite `port.text("rewrite", systemPrompt + rewriteNote(hits), providerMessages)` → `port.barrier()`; return `{reply, fallbackSent, condensed, checked}`. No D1 access. Empty reply → `AppError("UNCLEAR_RETRY")`
- [X] T026 [US1] Unit test `worker/test/unit/turn-pipeline.test.ts`: for one fixture problem/body, the S2 tutor `system` equals the system prompt the v1 path builds for the same inputs (capture it by calling `runConversationalTurn` with a fake `streamChat` that records `systemPrompt`) — byte-for-byte; `offline_note` appears only in the tutor/rewrite messages, never in the progress call's input
- [X] T027 [US1] Create `worker/src/routes/v2-turn.ts` (Hono, `installAuth`): zod body `{turn_key: uuid, request: chatRequestObject.extend({offline_note: z.string().max(600).optional()}) with the same superRefine, answers: record(max 8 entries)}`, body ≤ 256 KB; guards as v1 `routes/chat.ts` (unknown problem → `BAD_REQUEST`, killed → `PROBLEM_KILLED`, `hint_requested` → reuse the hint logic from `runHintTurn` but return JSON `{status:"done", reply, meta}`, `EMPTY_TURN`); read counters (`readCounters`), `assertNotJudged`, `planReservation` (cap = `cfg.trial.practice_turn_cap` for `isPracticeProblem`, else `cfg.chat.turn_cap`), compute `released`/`sessionEnded` with `releaseSolution` as v1; if `last_turn_key === turn_key`, plan with `last_turn_index` instead; run `runTurnSteps`; `NeedModel` → 200 `{status:"model", calls}`; `port.unused()` non-empty at done → `STEP_DIVERGED`; done → `commitTurn`, then `recordReachedKeys`/`recordAssistedKeys`/`recordNamedTerms` as v1, build `MetaFramePayload` exactly as v1 (`ready_to_finish`, `summary`, `summary_covers`, `leak_blocked`), return 200 `{status:"done", reply, meta}`. Mount in `worker/src/index.ts` with `app.use("/v2/turn", installAuth)`
- [X] T028 [US1] Contract tests `worker/test/contract/v2-turn.test.ts` (+ a helper `answerAll(calls, script)` in `worker/test/contract/helpers.ts`): port the behaviour cases of `chat.cap`, `chat.closed`, `chat.earlier-turns`, `chat.errors`, `chat.forged-solution`, `chat.guards`, `chat.hints`, `chat.leak`, `chat.privacy`, `chat.solution`, `chat.summary-covers`, `chat.wrapup*`, `finish-offer`, `trial.practice` to the step protocol; plus: no `device_day` change after a `status:"model"` step; same `turn_key` twice at done → turns +1 once; `offline_note` reaches the tutor call only; answers with an unknown id → `STEP_DIVERGED`

### Relay: judge and repair

- [X] T029 [US1] Create `worker/src/lib/judge-pipeline.ts`: `runJudgeSteps(body, problem, port)` mirroring `runJudge` in `worker/src/lib/judge-core.ts`: J1 `runFinishCheck(..., port.asStructuredCall("progress"))` → barrier; J2 `verifySettled(..., port.asStructuredCall("evidence"))` → barrier; J3 `port.json("judge", systemPrompt, userContent, buildJudgeSchema(problem), {required:true})` → barrier; J4 the self-contradiction second ask with `{attempt: 2}` → barrier; J5 `gatherEvidence(..., port.asStructuredCall("evidence"))` → barrier; return `postprocessJudge(...).assessment`. No D1 access, no `claimJudge`
- [X] T030 [US1] Create `worker/src/routes/v2-judge.ts` (`installAuth`): parse `{request: judgeRequestSchema, answers}`, v1 guards (`reveal_at_index` rule, killed problem), read counters and `assertNotJudged` up front, run pipeline, `NeedModel` → `status:"model"`; done → `claimJudge` (lost claim → `SESSION_ALREADY_JUDGED`), return `{status:"done", assessment}`. Mount in `worker/src/index.ts`
- [X] T031 [US1] Contract tests `worker/test/contract/v2-judge.test.ts`: port `judge.happy`, `judge.none`, `judge.once`, `judge.override`, `judge.settled`, `judge.solution-ended`, `judge.unclear`, `judge.evidence`, `judge.claim-release` (an abandoned loop leaves the session unjudged), `trial-judge-retry` behaviour; J4 is only asked for a self-contradictory J3
- [X] T032 [P] [US1] Create `worker/src/routes/v2-repair.ts` (`installAuth`): `{request: repairRequestSchema, answers}`; repair disabled → `done` with transcript unchanged as v1 `routes/repair.ts`; else `callRepairProvider` with `port.asProvider("repair")` (required) → barrier → v1 post-processing; mount; test `worker/test/contract/v2-repair.test.ts` porting `repair.*` cases

### App

- [X] T033 [US1] In `lib/features/chat/data/session_repository_impl.dart`, replace the `trialChat`/`chat` stream in `sendTurn` with `StepLoop.run((answers) => _relayClient.turnStep(installId, turnKey: userMessageId, request: request, answers: answers))`; on `done` yield `TurnEvent.token(reply)` then `TurnEvent.meta(counters)` from the `meta` map (reuse `MetaFrameDto.fromJson` and `_persistTurnReply` exactly as today); `ModelCallFailed(rateLimited)` → rethrow as `RelayException(RelayError.rateLimited …)` (use the existing rate-limit variant; `grep -n "rateLimit\|QUOTA" lib/core/errors`), `appCheck` → a new `RelayError.clientUnverified` with copy "This build can't reach the tutor." in `lib/l10n/app_en.arb` (+ every other ARB); keep the outbox behaviour for `TransportFailure`. Same change in `pullHint` (hint → `done` immediately). Outbox replay (`grep -rn "OutboxKind.chatTurn" lib`) goes through the same loop
- [X] T034 [US1] In `lib/features/assessment/data/assessment_repository_impl.dart`, replace `trialJudge`/`judge` with `StepLoop.run(... _relayClient.judgeStep ...)`, parse `assessment` with `AssessmentDto.fromJson`; keep recovery logic unchanged
- [X] T035 [P] [US1] In `lib/features/transcript/data/transcript_repair_repository_impl.dart`, route repair through `StepLoop` + `repairStep`; any failure keeps today's fallback (transcript unchanged)
- [X] T036 [US1] FR-015: sessions always open as `SessionPath.trial` in `session_repository_impl.dart` (ignore any stored key); remove the BYOK entry points from navigation — `lib/core/router/app_router.dart` routes `keysWall`/`keysEntry` redirect to home, `lib/features/settings/presentation/settings_screen.dart` hides the key-management row; fix router tests in `test/unit/router_guards_test.dart`
- [X] T037 [P] [US1] Set `defaultRelayBaseUrl` in `lib/core/config/relay.dart` to `https://dry-run-tutor-firebase.dryrun-app.workers.dev` (same account subdomain as today); update the file comment (the app now also talks to Firebase AI Logic, via the Firebase SDK, not dio)
- [X] T038 [US1] Security test `test/security/no_ground_truth_persisted_test.dart`: run a turn and a judge through `SessionRepositoryImpl`/`AssessmentRepositoryImpl` with an in-memory Drift DB, a fake relay returning a call whose `system` contains the marker `GT_MARKER_7f3a`, and a fake gateway; assert no table row and no outbox payload contains the marker. Update the doc comments in `test/security/host_allowlist_test.dart` and `lib/core/network/host_allowlist_interceptor.dart` (dio still relay-only)
- [X] T039 [US1] Update fakes/tests that used `trialChat`/`chat`/`judge`/`repair` (`test/fakes/mock_relay_client.dart`, `test/unit/*` — `grep -rln "trialChat\|trialJudge\|\.repair(" test`) to the step API; app green

### Harness, switch-off, deploy

- [X] T040 [US1] Create `worker/test/harness/lib/gemini-app-client.ts`: drives `/v2/turn` and `/v2/judge` through `SELF.fetch`, answering each `ModelCall` by POSTing to `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions` with `GEMINI_API_KEY` (system + messages, `max_tokens`, `temperature`, JSON calls with `response_format: {type:"json_schema", json_schema:{name, schema}}`); port `tutor.harness.test.ts` and `judge.harness.test.ts` to use it (copy as `*.gemini.harness.test.ts`); add script `"test:harness:gemini"` to `worker/package.json` (refuses to run without `GEMINI_API_KEY`, like `test:harness`); config override sets `gemini.models` to the ids in research.md R3
- [ ] T041 [US1] Run `GEMINI_API_KEY=… npm run test:harness:gemini` (ask the owner for a key); record tutor and judge pass rates next to the Nemotron baseline in `specs/010-firebase-hybrid-ai/research.md` (new section R14). If below baseline, try only config changes (model per purpose, thinking budget, temperature); prompt edits need the owner
- [X] T042 [US1] Unmount v1 model routes: remove `/v1/chat`, `/v1/judge`, `/v1/trial`, `/v1/repair` from `worker/src/index.ts`; delete `worker/src/routes/{chat,judge,trial,repair}.ts` and the v1 contract tests now covered by T028/T031/T032 (`chat.*`, `judge.*`, `repair.*`, `trial*`, `finish-offer`, `chat.key-check`, `chat.per-key-routing`); delete now-dead lib code only if `tsc` and tests still pass (`chat-core.ts` stays if `turn-pipeline.ts` imports from it); add a test that those four paths return 404; remove the dead methods `chat`, `trialChat`, `judge`, `trialJudge`, `repair` from `lib/core/network/relay_client.dart`. Relay green, app green
- [ ] T043 [US1] Deploy (owner confirms first): `npx wrangler d1 migrations apply dry-run-tutor-firebase --env firebase --remote`, secrets, seed the config row with the `gemini` block (worker/README.md §config), `npx wrangler deploy --env firebase`; add a "Firebase relay" section to `worker/README.md` with these commands
- [ ] T044 [US1] Device run quickstart.md §4 on the owner's phone (`fvm flutter run --release`); note the 5-turn median latency vs the `main` build in research.md R14 (SC-004)

**Checkpoint**: MVP — a full online session works on Gemini. Commit.

---

## Phase 4: User Story 2 — Offline on-device tutor (P2)

**Goal**: offline on a Nano phone, the on-device tutor keeps the learner talking from the public statement, labelled offline, outside cap and judge.

**Independent test**: quickstart.md §5 steps 1–3, 5.

- [X] T045 [US2] Create `android/app/src/main/kotlin/app/dryrun/OnDeviceModelChannel.kt` per contracts/on-device-channel.md (MethodChannel `app.dryrun/ondevice`: `status`, `download`, `generate`; EventChannel `app.dryrun/ondevice/download`), coroutines on `Dispatchers.Default`, results posted on the main thread; `generate` uses `Firebase.ai(backend = GenerativeBackend.googleAI()).generativeModel(modelName = "gemini-placeholder", onDeviceConfig = OnDeviceConfig(mode = InferenceMode.ONLY_ON_DEVICE, maxOutputTokens, temperature))` and rejects any response whose inference source is not on-device; error-code mapping per the contract; register in `android/app/src/main/kotlin/app/dryrun/MainActivity.kt` next to `TrustedTimeChannel`. **VERIFY** every class/enum name against the beta08 AAR (`find ~/.gradle/caches -name "firebase-ai-ondevice-16.0.0-beta08*"`, unzip `classes.jar`, `javap`)
- [X] T046 [P] [US2] Create `lib/core/ai/on_device_model.dart` (`OnDeviceStatus`, `OnDeviceDownloadEvent`, `OnDeviceModel` interface, `ChannelOnDeviceModel`) and `test/fakes/fake_on_device_model.dart`
- [X] T047 [US2] Create `lib/core/ai/on_device_model_service.dart`: holds current status as a `Stream<OnDeviceStatus>` + `current` getter; refreshes at startup, on app resume (`AppLifecycleListener`) and on download completed/failed; register in `setupLocator()`
- [X] T048 [US2] Drift: add `origin` column (`textEnum<MessageOrigin>()`, default `online`) to `Messages` in `lib/core/db/tables.dart`, `enum MessageOrigin { online, offline }` next to the other wire/db enums, bump `schemaVersion` and add the `addColumn` step in `lib/core/db/app_database.dart`; expose `origin` on the `Message` domain model `lib/features/chat/domain/message.dart`; migration test in `test/db/` following the existing migration tests
- [X] T049 [US2] In `session_repository_impl.dart`, exclude `origin == offline` rows from the request builder (`_buildChatRequest`: `messages`, `earlier_learner_turns`) and from the judge `conversation` in `assessment_repository_impl.dart` (FR-011a)
- [X] T050 [P] [US2] Create `lib/features/chat/data/offline_note.dart`: `String? offlineNote(List<Message> rows)` per research.md R10 / data-model.md §A3; test `test/unit/offline_note_test.dart` (no offline rows → null; trimming; 600-char cap; rows before the last sent online learner row ignored)
- [X] T051 [P] [US2] Create `lib/features/chat/data/offline_prompt.dart`: `buildOfflinePrompt(...)` per data-model.md §A4 (input type is the public problem model only); test `test/unit/offline_prompt_test.dart` (contains title/statement, the rules, ≤ 6 prior turns; no private field reachable — assert the function signature takes no private type)
- [X] T052 [US2] Create `lib/features/chat/data/offline_tutor.dart`: `Future<String> reply(ProblemPublic, List<Message> recent, String learnerText)` → `OnDeviceModel.generate(prompt, maxOutputTokens: 256, temperature: 0.4)` with 30 s timeout → guard per research.md R11 (fixed line `offlineTutorFallbackLine` from l10n); test `test/unit/offline_tutor_test.dart` with the fake model (empty, too long, code fence, "correct" → fallback line)
- [X] T053 [US2] Add `TurnEvent.offlineReply(String text)` to `lib/features/chat/domain/turn_event.dart` (regenerate freezed); handle it in `lib/features/chat/presentation/daily_session_cubit.dart` (end the sending state, counters unchanged, no finish-offer change) and in `lib/features/chat/data/turn_event_mapper.dart` if it switches exhaustively
- [X] T054 [US2] Offline path in `sendTurn` (`session_repository_impl.dart`), per data-model.md §A7 rows 1 and 4: on `TransportFailure` from the first or a later relay POST, if `OnDeviceModelService.current == available` → mark the learner row `origin: offline, delivery: sent`, call `OfflineTutor.reply`, insert the tutor row `origin: offline`, yield `offlineReply`; no outbox row; else today's behaviour. `downloading` → `failedRetryable` with new copy "The offline tutor is still downloading — try again soon."; channel `BUSY`/`BACKGROUND`/`FAILED` → `failedRetryable` with "The offline tutor is busy — try again in a moment." Add `offline_note: offlineNote(rows)` to the next online request. Bloc/repository tests in `test/unit/offline_send_test.dart`
- [X] T055 [US2] Offline label on bubbles: in `lib/features/chat/presentation/widgets/` (the message bubble widget — `grep -rln "class .*Bubble" lib/features/chat/presentation/widgets`) show a small "Offline tutor" caption under tutor rows with `origin == offline` (and a subtle marker on the learner row); l10n key `offlineTutorLabel`; golden or widget test in `test/widget/`
- [X] T056 [US2] Ending a session while offline: confirm the existing end-session + queued judge path still credits the streak and judges on reconnect with offline rows excluded (Principle IV/VIII); add a case to `test/unit/outbox_drain_bloc_test.dart` or the closest existing test
- [ ] T057 [US2] Device run quickstart.md §5 steps 1–3 and 5 on a Nano phone (owner)

**Checkpoint**: online + offline both work. Commit.

---

## Phase 5: User Story 3 — The app picks the model by itself (P3)

**Goal**: cloud when online; on-device when offline or the cloud refuses for rate limit/capacity; silent download.

**Independent test**: quickstart.md §5 step 4.

- [X] T058 [US3] In `sendTurn`, data-model.md §A7 row 2: `ModelCallFailed(rateLimited | unavailable)` on the required `tutor` call with on-device `available` → offline path from T054 (same rows, label, no cap); otherwise today's rate-limit copy. Never fall back on `appCheck`. Test in `test/unit/offline_send_test.dart`
- [X] T059 [US3] Auto-download in `on_device_model_service.dart`: when status is `downloadable` and connectivity is online (existing `connectivity_plus` usage — `grep -rn "Connectivity()" lib`), call `download()` once per app run; no UI prompt (spec US3 scenario 2)
- [X] T060 [US3] Debug-only toggle "Simulate cloud rate limit" in `lib/features/settings/presentation/settings_screen.dart` (rendered only when `kDebugMode`), backed by a flag the gateway reads: a `DebugModelGateway` decorator in `lib/core/ai/` returning `ModelAnswer.error(rateLimited)` for `purpose == "tutor"` when on; wired in `setupLocator()` only under `kDebugMode`
- [ ] T061 [US3] Device run quickstart.md §5 step 4 (owner)

---

## Phase 6: User Story 4 — Judges can install, test and understand it (P3)

**Goal**: README + downloadable APK let a judge see both models in < 5 minutes.

**Independent test**: quickstart.md §6, §8.

- [X] T062 [P] [US4] README.md: add "How it uses Firebase AI Logic" near the top — a 3-row table (cloud Gemini: tutor replies, progress/evidence checks, judge, transcript repair — called from the app via `firebase_ai`, App Check on; Gemini Nano on device: the offline tutor via `firebase-ai-ondevice` `ONLY_ON_DEVICE`; relay: prompts, ground truth, cap, leak filter, judge post-processing, no model key), a one-paragraph diagram of the step protocol, "See the offline tutor" steps (supported phones, airplane mode, label), "On a phone without Gemini Nano you will see …", install steps for the release APK, emulator/root caveat (App Check). Remove Nebius-specific copy. Keep it skimmable
- [X] T063 [P] [US4] Confirm `LICENSE` is MIT with the owner's name and year 2026
- [ ] T064 [US4] Signed release APK: `fvm flutter build apk --release`; quickstart.md §6 on two phones; flip App Check enforcement to Enforced only if it passes (owner, console); otherwise leave Monitoring and say so in README
- [ ] T065 [US4] Owner says "submitting" → create public repo `dry-run-tutor-firebase` (remote `firebase`), push `firebase-main` as `main` there, attach the APK to a GitHub release, link it from README. Not before

---

## Phase 7: Polish & cross-cutting

- [X] T066 [P] Settings row "Offline tutor: Ready / Downloading / Not supported on this phone" in `lib/features/settings/presentation/settings_screen.dart`, from `OnDeviceModelService`; l10n
- [ ] T067 [P] Lower the AI Logic per-user quota to 30 RPM in the Cloud console (owner) — research.md R3
- [ ] T068 Latency check SC-004; if over budget, first set `thinking_budget` 0 for every purpose and the lite model for `progress`; record in research.md R14
- [X] T069 [P] Update `docs/` or `specs/010-firebase-hybrid-ai/quickstart.md` with anything that differed in reality (actual model ids, App Check result, API names found by VERIFY steps)
- [ ] T070 Owner approves the constitution 5.0.0 amendment from T005; record approval in its Sync Impact Report
- [ ] T071 Final: relay green, app green, `git diff main -- worker/wrangler.jsonc` shows only the firebase env, Cloudflare shows no new deploys of `dry-run-tutor` or the PayPal worker (SC-006)

---

## Dependencies & execution order

- **Phase 1** → **Phase 2** → **US1 (Phase 3)** → US2 (Phase 4) → US3 (Phase 5); **US4 (Phase 6)** README can start any time after T044; Phase 7 last.
- US2 needs US1's app loop (T033) because the offline path is a branch of `sendTurn`. US3 needs US2's offline path (T054).
- Within Phase 2: T009 before T010; T011 before T012/T013; T014 before T016/T017/T021; T018–T020 before T021–T023.
- Within US1: T025 → T026/T027 → T028; T029 → T030 → T031; T033–T035 need T022–T024; T040 needs T027 + T030; T042 after T028, T031, T032, T039; T043 after T042; T044 after T043.
- Owner-blocked tasks: T005 (approval later, T070), T014, T041 (API key), T043, T057, T061, T064, T065, T067.

## Parallel examples

- Phase 1: T002, T003, T004, T005 together after T001.
- Phase 2: relay T006, T007, T008 together; app T018, T019, T020, T022 together once T015 is done.
- US1: T029–T031 (judge) can run alongside T025–T028 (turn); T032 and T035 alongside both; T037 any time.
- US2: T046, T050, T051 together; T045 (Kotlin) alongside the Dart tasks.
- US4: T062, T063 alongside US2/US3.

## Implementation strategy

1. **MVP = Phases 1–3 (US1)**: the entry is valid once online sessions run on Gemini via Firebase AI Logic with App Check. Target end of day 3 (2026-11-26).
2. **US2 + US3** (day 4–5): the hybrid story the judges score first.
3. **US4** (day 6, must not slip): README, APK, video. Submission closes 2026-11-30 14:00 PT.
4. Polish only with time left.
