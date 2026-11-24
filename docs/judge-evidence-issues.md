# Judge issues: unearned passes and contradictory copy

**Status**: fixed on branch `fix/judge-evidence` per `tasks/plans/PLAN_02_JUDGE_EVIDENCE.md`. The step 4 below ("zero insights → unclear") was replaced by approach evidence: a full, verified description of the loop approach that never mentions shrinkage is correctly `borderline`, and naming a technique without describing it is caught by the approach check instead.

Found 2026-10-11 while playtesting problem `vp-0002` (Add Digits) on a debug build.
Two bugs, both in the worker's judge post-processing. The Flutter app needs no change.

## Repro sessions

Each session had one learner turn, after which the learner tapped Finish.

| Learner said | Tutor replied | Shown verdict | Shown copy | Expected |
|---|---|---|---|---|
| `nested loop` | Asked what stops the outer loop | **Solid approach** (`pass`), "Reached: Process shrinks fast" | "This matched a solid, accepted approach." | Hard to call (`unclear`) |
| `brute force` | "Yes — brute-force looping works…" | (not captured) | (not captured) | Hard to call (`unclear`) |
| `hash map` | Explained hash maps | Hard to call (`unclear`), Approach: None | "This matched a solid, accepted approach." | Hard to call, and copy that matches the verdict |

---

## Issue 1: the judge credits insights the learner never stated

### Symptom

Typing only "nested loop" scored `pass`. The learner said nothing about termination, digit sums shrinking, or a stop condition.

### Trace

1. The model matched `iterative_digit_sum`, which is authored as `acceptable`.
2. The model put `process_shrinks_fast` in `insights_hit`. Nothing in the transcript supports that.
3. `iterative_digit_sum.requires = ["process_shrinks_fast"]` (`content/problems/vp-0002.json`), so every required insight now counted as hit.
4. `mapVerdict` (`worker/src/lib/verdict-map.ts:52-68`) returned `pass`.
5. The low-confidence guard in `postprocessJudge` (`judge-postprocess.ts`, step 3) did not fire. Either the model's confidence was ≥ 0.6, or the model's own verdict was already a pass.

### Root cause

`insights_hit` is a bare list of keys. **The server has no way to check that an insight was actually said.** The judge prompt already says "naming a technique is not describing it", but that rule depends on the model following it, and here it didn't. `mapVerdict` trusts the model's insight list completely, and that list is the main input to the verdict.

### Rejected fix: minimum word count / turn count

- **Short correct answers get capped.** "Sum digits, mod 9, multiples of 9 give 9" is about 10 words and correct, but would be marked unclear.
- **Long empty answers get through.** Thirty words of filler clear any floor, and the model can still invent insights for them.

### Recommended fix: evidence-backed insights, verified on the server

1. **Schema** (`worker/src/lib/judge-schema.ts`, and `specs/001-proxy-content-contract/contracts/judge-output.schema.json`)
   - Change `insights_hit` from `string[]` to `{ key: <insight enum>, quote: string }[]`.
   - `quote` is a verbatim excerpt of what the **learner** said that shows the insight.

2. **Prompt** (`worker/src/prompts/judge.ts`, plus `specs/001-proxy-content-contract/contracts/judge-system-prompt.md`, which `prompts-verbatim.test.ts` requires to be byte-identical)
   - Add a line: "For each insight in insights_hit, copy the learner's own words that show it into `quote`. If you cannot quote them, the insight is missed. Words the tutor said do not count."

3. **Verification** (`worker/src/lib/judge-postprocess.ts`, step 2 "insight coverage repair")
   - `postprocessJudge` needs the conversation it judged. Pass it in from `runJudge` (`judge-core.ts`): use the post-truncation `conversation`, i.e. after the `ended_by === "solution"` slice.
   - Build the learner corpus from `role === "user"` turns only. A hint from the tutor must never count as the learner's insight.
   - Normalise both the quote and the corpus: lowercase, strip punctuation, collapse whitespace.
   - Accept the quote if it is a substring of the corpus. As a fallback for small paraphrases, accept it if ≥ 80% of its tokens appear in one contiguous window of the learner's text.
   - An insight that fails verification moves to `insights_missed`.
   - Record a reason or counter for each dropped insight in logs. Log no transcript content (see `no-content-persisted.test.ts`).

4. **Thin-evidence rule** (`worker/src/lib/verdict-map.ts`, `mapVerdict`)
   - **Today:** `insights_hit.length === 0` gives `unclear` only if the model itself said `unclear`, or the approach is `none`.
   - **Change:** after verification, zero insights gives `unclear` regardless of the model's verdict.
     - Exception: a matched `wrong` approach, or a `wrong_turns_taken` entry that breaks correctness, still gives `incorrect`.
   - This puts the prompt's "naming a technique is not describing it" into code.
   - **Check:** `isSelfContradictory` (good approach + zero insights) currently triggers a judge retry. Decide whether a retry is still worth it when the zero comes from failed verification rather than from the model. Probably not: verification is deterministic, so a retry would just use up provider budget.

5. **Response shape:** remove `quote` before the assessment leaves the worker, so `insights_hit` stays `string[]` on the wire. The app (`judge_dto.dart`, the outbox and the Drift tables) stays unchanged.

### Expected outcomes

| Input | After the fix |
|---|---|
| "nested loop" | `unclear` (the quote "nested loop" does not support `process_shrinks_fast`) |
| "brute force" | `unclear` |
| "hash map" | `unclear` |
| "loop summing digits while it's over 9; it shrinks fast since a 10-digit number sums to under 100" | `pass` (iterative approach, verified `process_shrinks_fast`) |
| "sum is same remainder mod 9 as the number, but multiples of 9 give 9 not 0" | `pass` or `strong_pass` (both required insights verified) |

---

## Issue 2: "This matched a solid, accepted approach" shown when no approach matched

### Symptom

The "hash map" session showed **Hard to call** and **Approach: None**, and also "This matched a solid, accepted approach."

### Root cause

`worker/src/lib/judge-postprocess.ts`, in the `repaired` object:

```ts
matched_verdict: authoredApproach?.verdict ?? out.matched_verdict,
```

The model returned `matched_approach: "none"` with `matched_verdict: "acceptable"`. No authored approach has the key `none`, so the code fell back to the model's own `"acceptable"`.

The app then:
- picked `matchedApproachAcceptable` for the copy (`lib/features/assessment/presentation/assessment_copy.dart:33`), and
- rendered the Approach row as "None", because `share_card.dart:229` hides that row only when `matchedVerdict == none`.

### Fix

- If `matched_approach` is not an authored key (in practice `"none"`), force `matched_verdict` to `"none"`. An approach that doesn't exist can't carry a tier.
- With that in place, the app shows "Nothing here matched an approach on file." and hides the Approach row. No Flutter change is needed.
- Check `mapVerdict`'s final branch (`if (out.matched_verdict === "none") return "pass"`). It now becomes the only route for an unlisted-but-sound approach, so it must also meet the verified-insights requirement from Issue 1. Zero verified insights must give `unclear`, never `pass`.

---

## Tests to add (write first, confirm they fail)

Worker, vitest:

- **Unit, `judge-postprocess`**
  - A quote not present in the learner's turns moves the key to `insights_missed`.
  - A quote present only in a **tutor** turn moves it to missed.
  - A quote with case or punctuation differences is still accepted.
  - A near-paraphrase above the 80% token-window threshold is accepted. One below the threshold is rejected.
  - Quotes are stripped from the returned `Assessment`.
  - `matched_approach: "none"` combined with `matched_verdict: "acceptable"` gives `matched_verdict: "none"`.
- **Unit, `verdict-map`**
  - Zero insights, an acceptable approach and a model verdict of `pass` give `unclear`.
  - Zero insights and a matched `wrong` approach give `incorrect`.
  - `none` approach with zero insights gives `unclear`.
- **Contract, `judge.*.test.ts`:** replay the three screenshot sessions above as fixtures against a stubbed provider that returns the over-crediting output observed. Assert `unclear` for each.
- **Harness corpus** (`harness-corpus.test.ts`, `judge.harness.test.ts`): update fixtures to the new `{key, quote}` shape. Add the "nested loop" and "brute force" one-liners as must-not-pass cases.

## Files touched

- `worker/src/lib/judge-schema.ts`
- `worker/src/lib/judge-postprocess.ts`
- `worker/src/lib/judge-core.ts` (pass the conversation into post-processing)
- `worker/src/lib/verdict-map.ts`
- `worker/src/prompts/judge.ts` and `specs/001-proxy-content-contract/contracts/judge-system-prompt.md` (kept byte-identical)
- `specs/001-proxy-content-contract/contracts/judge-output.schema.json`
- Tests listed above

## Out of scope

- **Blocking Finish after one turn.** A one-turn session should be allowed to finish. It just needs an honest `unclear`.
- **Content edits to `vp-0002`.** Once insights need evidence, `requires: ["process_shrinks_fast"]` is a reasonable bar.

## Estimate

About 2–3 hours. Most of the time goes into updating existing judge contract tests and harness fixtures for the schema change.
