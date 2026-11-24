# Contract: Relay step protocol (`/v2/turn`, `/v2/judge`, `/v2/repair`)

Relay: `dry-run-tutor-firebase` (new Worker, own D1). Auth: `X-Install-Id`, the
same `installAuth` middleware as v1. No `X-User-Key`, no `X-Provider` — the relay
holds no model key and calls no model (research.md R1).

## The idea in one paragraph

The relay still runs the whole tutor/judge pipeline, but it cannot call a model.
When the pipeline needs a model answer, the relay returns the call it wants made
(`status: "model"`). The app makes that call with Firebase AI Logic, then POSTs
the **same request again** with the answers added. The relay re-runs the
pipeline from the top; the answered calls now resolve, and it either asks for
the next calls or returns the checked result (`status: "done"`). The relay keeps
no state between steps. All D1 writes happen only on the final (`done`) step.

```
app                                   relay                              Gemini
 │ POST /v2/turn {request, answers:{}}  │                                    │
 │─────────────────────────────────────▶│ read counters, build prompts       │
 │◀─ 200 {status:model, calls:[A,B]} ───│ (no D1 write)                      │
 │ generateContent(A) ∥ generateContent(B) ────────────────────────────────▶│
 │◀──────────────────────────────────────────────────────────── text, json ─│
 │ POST /v2/turn {request, answers:{A:…,B:…}}                                │
 │─────────────────────────────────────▶│ re-run; leak filter on A          │
 │◀─ 200 {status:done, reply, meta} ────│ commit: reserve turn, record keys  │
```

## Common shapes

### `ModelCall` (relay → app)

```json
{
  "id": "c_3f9a1b2c4d5e6f70",
  "purpose": "tutor",
  "model": "<from config gemini.models.tutor>",
  "system": "…full system instruction, may contain ground truth…",
  "messages": [{ "role": "user", "text": "…" }, { "role": "model", "text": "…" }],
  "output": { "kind": "text" },
  "max_output_tokens": 400,
  "temperature": 0.4,
  "thinking_budget": 0,
  "timeout_ms": 20000,
  "required": true
}
```

| Field | Rule |
|---|---|
| `id` | `c_` + 16 hex chars: FNV-1a 64 over the canonical JSON of every other field. Deterministic: the same pipeline state always produces the same id. |
| `purpose` | `tutor` · `rewrite` · `progress` · `condense` · `evidence` · `judge` · `repair`. Informational for the app (logging is forbidden, see below); the app MUST NOT branch prompt content on it. |
| `model` | From remote config (`gemini.models[purpose]`, data-model.md §R3). The app uses it verbatim. |
| `messages[].role` | `user` or `model` (Gemini vocabulary). The relay translates `tutor → model`. |
| `output` | `{ "kind": "text" }` or `{ "kind": "json", "schema": <GeminiSchema> }`. |
| `thinking_budget` | Integer or `null` (= model default). Applied through `ThinkingConfig` when not null. |
| `timeout_ms` | The app abandons the call after this long and answers `{"error":"timeout"}`. |
| `required` | `true`: if this call fails, the app stops the loop (the step fails, see Errors). `false`: the app answers `{"error": …}` and continues. |

`GeminiSchema` is the subset the relay emits and the app converts to
`firebase_ai` `Schema` (research.md R4): `type` ∈ `object|array|string|number|integer|boolean`,
`properties`, `required` (object), `items` (array), `enum` (string only),
`nullable: true`. Nothing else — no `additionalProperties`, no type arrays,
no `$ref`. `relay-steps.test.ts` asserts every schema the relay emits fits.

### `ModelAnswer` (app → relay), keyed by call id

```json
{ "c_3f9a1b2c4d5e6f70": { "text": "…" } }
{ "c_aa…": { "json": { "insights": [] } } }
{ "c_bb…": { "error": "timeout" } }
```

`error` ∈ `rate_limited` · `unavailable` · `timeout` · `blocked` (safety block or
empty candidate) · `bad_output` (json kind but unparseable) · `other`.
Only `required: false` calls may be answered with `error`.

### Step response (relay → app)

```json
{ "status": "model", "calls": [ModelCall, …] }       // 1–3 calls, run in parallel
{ "status": "done", … endpoint-specific … }
```

Errors use the existing v1 envelope and status codes (`lib/errors.ts`) unchanged,
plus one new code:

| Code | HTTP | Meaning | App does |
|---|---|---|---|
| `STEP_DIVERGED` | 409 | An answer's id matches no call this step would make (state changed between steps, or a stale retry). | Restart the loop once with `answers: {}`; second time → `UNCLEAR_RETRY` UI. |

## Limits

- At most **6** POSTs per turn/judge loop (app-enforced; relay also rejects a body
  with more than 8 answers as `BAD_REQUEST`).
- Body ≤ 256 KB. Every answer `text` ≤ 8 000 chars; every `json` ≤ 16 KB serialized.

## `POST /v2/turn`

Request:

```json
{
  "turn_key": "7b1e…uuid of the learner's message row",
  "request": { …exactly the v1 ChatRequest body (schemas.ts chatRequestObject)…,
               "offline_note": "optional, ≤ 600 chars" },
  "answers": {}
}
```

- `request.hint_requested: true` → returns `done` at once (no model call), same
  as the v1 hint branch. `turn_key` is ignored for hints.
- `offline_note` (FR-011a): learner-only quotes from offline turns since the last
  online turn, built by the app (data-model.md §A3). Inserted as a context line
  for the tutor call only. It is NOT learner history: it does not reach the
  progress check, the leak filter's named terms, or the judge.

Pipeline stages (each ends with a barrier: if any call is unanswered, return
`status: model` with all unanswered calls of that stage):

| Stage | Calls | Runs when |
|---|---|---|
| S1 | `condense` (required: false) | condensation threshold reached (`cfg.trim`), as v1 |
| S2 | `tutor` (required: true) ∥ `progress` (required: false) | always; `progress` only if `finish_offer.enabled` and session not ending, as v1 |
| S3 | `rewrite` (required: false) | the tutor draft hits the blocked-term filter after the S2 progress result is applied, as v1 |
| Commit | — | D1: reserve turn (idempotent per `turn_key`), record reached/assisted/named keys |

`done` body:

```json
{ "status": "done", "reply": "…checked tutor text…", "meta": { …v1 MetaFramePayload, unchanged… } }
```

Guards before S1, same as v1, same codes: `PROBLEM_KILLED`, `EMPTY_TURN`,
`TURN_CAP_REACHED` (read-only check here; enforced again atomically at commit),
`SESSION_ALREADY_JUDGED`.

Idempotency: if `turn_key` equals the row's `last_turn_key`, the commit does not
reserve again; it rebuilds the result with `last_turn_index` (data-model.md §R1).
A network drop after commit therefore never costs a second turn.

## `POST /v2/judge`

Request: `{ "request": { …v1 JudgeRequest… }, "answers": {} }`

| Stage | Calls | Notes |
|---|---|---|
| J1 | `progress` (required: false) | final progress check on the judged conversation (v1 `runFinishCheck`) |
| J2 | `evidence` (required: false) | `verifySettled`, only if J1 found evidence |
| J3 | `judge` (required: true) | structured, schema enums from this problem's keys (Principle II) |
| J4 | `judge` again (required: false) | only if J3 is self-contradictory (v1 rule) — a second call with an identical prompt needs a distinct id, so it carries `"attempt": 2` in its canonical JSON |
| J5 | `evidence` (required: false) | `gatherEvidence` on the kept answer |
| Commit | — | `claimJudge` (atomic; `SESSION_ALREADY_JUDGED` if lost) |

`done` body: `{ "status": "done", "assessment": { …v1 Assessment, unchanged… } }`

## `POST /v2/repair`

Request: `{ "request": { …v1 RepairRequest… }, "answers": {} }` — one stage, one
`repair` call (required: true). `done` body: the v1 repair response.
If `cfg.repair` is absent or disabled: `done` with the transcript unchanged, as v1.

## What the app MUST NOT do with a `ModelCall` (FR-006)

- Write `system`, `messages` or any answer to disk, Drift, `shared_preferences`,
  the outbox, logs, `debugPrint`, crash reports, or analytics.
- Keep it after the loop ends (success or failure). Outbox rows store only the
  original `request`, never calls or answers.
- Send it anywhere but Firebase AI Logic.
