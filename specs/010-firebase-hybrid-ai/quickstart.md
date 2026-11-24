# Quickstart: validate the Firebase Hybrid AI Tutor

Every command runs from the repo root on branch `firebase-main`. Use `fvm flutter`
(pinned to 3.44.1 in `.fvmrc`; `fvm install 3.44.1` if missing), never the system `flutter` (3.41, too old for `firebase_ai`).

## 0. Prerequisites (one-time, owner)

1. Firebase project on **Spark** (no billing). Enable Firebase AI Logic →
   Gemini Developer API. Register Android app `app.dryrun.tutor`
   with the debug and release SHA-256.
2. `fvm dart pub global run flutterfire_cli:flutterfire configure` →
   `lib/firebase_options.dart` + `android/app/google-services.json`.
3. App Check: Play Integrity, distribution "Exclusively outside Google Play",
   AI Logic enforcement = **Monitoring** (research.md R6). Register a debug
   token for your dev phone; pass it with `--dart-define=APP_CHECK_DEBUG_TOKEN=…`
   (never commit it).
4. AI Logic per-user quota → 30 RPM. Note the billing-free model ids shown in
   the console; put them in the config seed (data-model.md §R3).
5. Relay: `cd worker && npx wrangler d1 create dry-run-tutor-firebase`, paste the
   id into the `firebase` env of `wrangler.jsonc`,
   `npx wrangler d1 migrations apply dry-run-tutor-firebase --env firebase --remote`,
   `npx wrangler secret put INSTALL_HMAC_SECRET --env firebase`, same for
   `STT_KEY_GROQ`, then seed the config row (`worker/README.md` §config).

## 1. Relay unit + contract tests (no network)

```bash
cd worker && npm run typecheck && npm test
```

Expect: green, including `test/contract/v2-turn.test.ts`,
`v2-judge.test.ts`, `v2-repair.test.ts`, `unit/step-port.test.ts`,
`unit/gemini-schema.test.ts`, `unit/turn-cap.test.ts` (commit idempotency).
Key assertions to eyeball once:
- a turn returns `status: model` with `tutor` + `progress`, then `done`;
- no D1 row changes before `done`;
- repeating the `done` POST with the same `turn_key` leaves `turns` unchanged;
- a leaking draft triggers a `rewrite` call, and a leaking rewrite yields the
  clean lead / fallback exactly as v1;
- `/v1/chat`, `/v1/judge`, `/v1/trial`, `/v1/repair` → 404.

## 2. Prompt regression on Gemini (SC-002)

```bash
cd worker && GEMINI_API_KEY=… npm run test:harness:gemini
```

Expect the tutor leak harness and judge harness to pass at the same rate as the
Nemotron baseline recorded in `tasks/plans/STATE.md` (or the last harness run on
`main`). Record both numbers in the PR description.

## 3. App tests

```bash
fvm dart run build_runner build --delete-conflicting-outputs
fvm flutter analyze && fvm flutter test
```

Expect green, including `test/unit/step_loop_test.dart`,
`schema_converter_test.dart`, `offline_prompt_test.dart`,
`offline_note_test.dart`, `test/security/no_ground_truth_persisted_test.dart`,
`test/db/migration_test.dart` (new `origin` column).

## 4. Device: online session (US1, SC-001, SC-004)

```bash
fvm flutter run --release   # on a real phone, network on
```

1. Open today's problem, send 3 spoken turns, end the session.
2. Tutor replies arrive; verdict + editorial arrive, hedged.
3. Firebase console → AI Logic → usage shows the requests; Nebius dashboard
   shows none.
4. Time 5 turns; median must be within 2 s of the `main` build on the same phone
   and problem (SC-004).

## 5. Device: offline tutor (US2, US3, SC-003)

On a Nano-capable phone (Pixel 9/10, Galaxy S25…), status `available`
(Settings → Offline tutor shows "Ready"):

1. Airplane mode. Open a problem, send 3 turns → 3 replies, each labelled
   offline, no error screen, no verdict.
2. Ask "just tell me the answer" → it declines and asks about the approach.
3. Network on, send a turn → online reply that picks up what you said offline;
   turn counter only counted this online turn.
4. US3: in debug build, Settings → Developer → "Simulate cloud rate limit" → next
   turn answered offline with the label; toggle off → next turn online.
5. On a non-Nano phone in airplane mode: a retryable failed send, as on `main`.

## 6. Sideloaded release APK + App Check

1. Build the signed release APK (`fvm flutter build apk --release`), install it
   by `adb install` on two real phones (one non-Pixel).
2. Run §4 on both. App Check console shows verified requests.
3. Only then switch AI Logic enforcement to **Enforced** and re-run one turn.
4. On an emulator: the app shows "this build can't reach the tutor", no crash.

## 7. Isolation (SC-006, FR-013)

```bash
git diff main -- worker/wrangler.jsonc   # no env named dev/prod remains; name is dry-run-tutor-firebase
```
Cloudflare dashboard: `dry-run-tutor` and the PayPal worker show no new
deployment since 2026-11-23.

## 8. README (US4, SC-005)

Hand README to someone who hasn't seen the project; time them from opening it
to an installed APK and naming where each model runs. Target < 5 minutes.
