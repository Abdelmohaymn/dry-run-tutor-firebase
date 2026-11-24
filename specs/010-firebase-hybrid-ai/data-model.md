# Data Model: Firebase Hybrid AI Tutor

Part R = relay (`worker/`). Part A = app (`lib/`). Only changes are listed;
everything else is as on `main`.

## Part R — relay

### R1. `device_day` (D1) — two new columns, migration `0013_turn_key.sql`

| Column | Type | Rule |
|---|---|---|
| `last_turn_key` | TEXT NULL | The `turn_key` of the last committed conversational turn. |
| `last_turn_index` | INTEGER NULL | The `turns` value that commit produced. |

Commit (`commitTurn`, new, `lib/turn-cap.ts`):
- If `last_turn_key = turn_key` → no increment; return the stored counters with
  `turnIndex = last_turn_index` (idempotent retry).
- Else one atomic `INSERT … ON CONFLICT DO UPDATE … RETURNING`, same arithmetic
  as today's `reserveTurn`, also setting `last_turn_key`, `last_turn_index`.
  `turns > cap` → `TURN_CAP_REACHED` (and the row is NOT incremented — use a
  `WHERE device_day.turns < ?cap` guard, then treat "no row returned" as cap).
- If the committed `turnIndex` ≠ the index the pipeline planned with →
  `STEP_DIVERGED` (another turn committed in between). No write in that case:
  check the planned index inside the same statement
  (`WHERE device_day.turns = ?planned - 1`).

Pure helper `planReservation(counters, cap, claimedSolutionRequests)` returns
the same `{turnIndex, solutionRequests}` `reserveTurn` would, without writing.
Unit test: for every case in `turn-cap.test.ts`, `planReservation` ==
`reserveTurn` result.

The new relay's D1 is fresh: apply migrations `0001…0013` in order.

### R2. Step state (in request only, never stored)

```ts
type ModelCall = {
  id: string; purpose: Purpose; model: string; system: string;
  messages: { role: "user" | "model"; text: string }[];
  output: { kind: "text" } | { kind: "json"; schema: GeminiSchema };
  max_output_tokens: number; temperature: number;
  thinking_budget: number | null; timeout_ms: number; required: boolean;
};
type ModelAnswer = { text: string } | { json: unknown } | { error: AnswerError };
type Answers = Record<string, ModelAnswer>;
```

`StepPort` (`lib/step-port.ts`, new): built from `answers` + config.
- `text(purpose, system, messages, opts)` / `json(purpose, system, user, schema, opts)`
  build the call, compute its id, and return the answer if present; else record
  the call as pending and throw `PendingCall`.
- `asProvider(purpose)` → an object implementing today's `Provider`
  `structuredCompletion` (for `condense()`, `callRepairProvider()`), and
  `asStructuredCall(purpose)` → today's `FinishCheckCall`/`EvidenceCall` shape,
  so `runFinishCheck`, `verifySettled`, `gatherEvidence` are reused unchanged.
- `barrier()` → throws `NeedModel(pendingCalls)` if anything is pending.
- `unused()` → answer ids no call asked for; non-empty at `done` → `STEP_DIVERGED`.
- An `{error}` answer makes the call throw an `AppError` (`UNCLEAR_RETRY`); the
  reused functions already catch and fall back for optional calls.

Because the existing helpers swallow errors (e.g. `runFinishCheck` returns
`null`), stage code MUST call `port.barrier()` after each stage and MUST NOT
trust a `null` result before the barrier.

### R3. Runtime config (D1 `config` row) — new `gemini` block

```json
"gemini": {
  "models": {
    "tutor": "<stable flash id>", "rewrite": "<stable flash id>",
    "progress": "<lite id>", "evidence": "<lite id>", "condense": "<lite id>",
    "judge": "<stable flash id>", "repair": "<lite id>"
  },
  "thinking_budget": { "tutor": 0, "rewrite": 0, "judge": null, "default": 0 },
  "timeout_ms": { "tutor": 20000, "judge": 30000, "default": 12000 },
  "temperature": { "tutor": 0.4, "rewrite": 0.4, "default": 0 },
  "max_output_tokens": { "tutor": 400, "rewrite": 400, "judge": 2000, "default": 1000 }
}
```

- zod schema in `runtime-config.ts`; required in the Firebase relay (no default
  model id compiled in). Values to seed: research.md R3.
- `timeout_ms.progress` defaults to `finish_offer.timeout_ms` so today's
  `withinMs` semantics move to the app unchanged.
- `GET /v1/config` strips `gemini` (the app gets model ids per call, not up
  front) — same rule as `model` today.
- Unused on this relay and may stay at defaults: `provider`, `keyed_providers`,
  `providers`, `trial.*` pool members. `chat.turn_cap` is the cap for v2;
  `trial.practice_turn_cap` is the cap for the practice problem.

## Part A — app

### A1. `Messages` (Drift) — new column `origin`

| Column | Type | Rule |
|---|---|---|
| `origin` | `textEnum<MessageOrigin>()`, default `online` | `online` or `offline`. Set on both the learner turn and the tutor reply of an offline exchange. |

- Schema version +1, migration `addColumn(messages, messages.origin)`.
- `_buildChatRequest` excludes `origin == offline` rows from `messages`,
  `earlier_learner_turns` and the judge `conversation` (FR-011a).
- Rendering: offline rows keep their place and show the offline label (FR-010).
- An offline learner row is `delivery = sent` (it was answered); it is never
  queued in the outbox.

### A2. `ModelCall`, `ModelAnswer` DTOs (in memory only)

`lib/core/network/dto/step_dto.dart` (freezed + json_serializable):
`ModelCallDto`, `ModelOutputDto` (union text/json), `StepResponseDto` (union
`model(calls)` / `done(json)`), answers as `Map<String, Object?>` built by
`ModelAnswer.toJson()`. Never passed to a DAO. Never put in Cubit state.

### A3. Offline note

Derived, not stored: offline learner rows with `seq` greater than the last
`online` learner row that is `delivery = sent`. Built by
`offlineNote(rows) → String?` (research.md R10). Sent as
`request.offline_note` on the next online turn. Once that turn succeeds, a newer
online row exists, so the same rows are never sent twice.

### A4. Offline prompt (bundled, public only)

`lib/features/chat/data/offline_prompt.dart`: one function
`buildOfflinePrompt(ProblemPublic p, List<Message> recent, String learnerText)`
returning ONE string (Nano has no chat):

1. Fixed rules (FR-011): you are an offline practice partner; you do not know
   the answer; ask ONE short question; ask for the approach, a small example or
   its cost; never say correct/wrong; never give a solution or code; if asked
   for the answer, say you can't give one offline and ask about their approach;
   reply in the learner's language; ≤ 2 sentences.
2. Problem title + statement + constraints (public half only — FR-009; never
   hints, never editorial).
3. The last ≤ 6 turns (any origin), `Learner:` / `Partner:` lines, each ≤ 300 chars.
4. `Learner: <learnerText>` / `Partner:`.

Ground truth cannot reach it: the function's only input type is the public
problem model. A unit test asserts no field of `ProblemPrivate` is reachable.

### A5. On-device status

```dart
enum OnDeviceStatus { unavailable, downloadable, downloading, available }
```
From `OnDeviceModel.status()` (contracts/on-device-channel.md). Cached in a
`ValueNotifier`/stream inside `OnDeviceModelService` (registered in `get_it`),
refreshed at launch, on resume, and after a download event.

### A6. `TurnEvent` — new variant

```dart
const factory TurnEvent.offlineReply(String text) = TurnEventOfflineReply;
```
Yielded by `sendTurn` instead of `token` + `meta` when the offline tutor
answered. The Cubit appends nothing itself (rows come from `watchMessages`),
leaves `ServerCounters` unchanged, and clears the sending state.

### A7. Failure → route table (`SessionRepositoryImpl.sendTurn`)

| What happened | On-device `available` | Otherwise |
|---|---|---|
| First relay POST: `TransportFailure` | offline tutor | today: `failedRetryable` + outbox |
| Required `tutor` call: rate limit / quota / `unavailable` | offline tutor | `failedRetryable`, rate-limit copy |
| Required call: App Check failure | `failedRetryable`, "this build can't reach the tutor" | same |
| Later relay POST: `TransportFailure` (reply not checked) | offline tutor | `failedRetryable` (never show the unchecked draft) |
| Relay error envelope (`TURN_CAP_REACHED`, …) | today's handling | today's handling |
| `STEP_DIVERGED` | restart loop once, then `UNCLEAR_RETRY` | same |

On-device `downloading` while offline → `failedRetryable` with copy "The
offline tutor is still downloading — try again soon." (spec edge case).
