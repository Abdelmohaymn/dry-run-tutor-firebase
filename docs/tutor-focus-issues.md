# Tutor issues: skipped questions and re-asked answers

**Status**: fixed on `fix/judge-evidence` (stacked after JUDGE_EVIDENCE) per `tasks/plans/PLAN_03_TUTOR_FOCUS.md`; the vp-0014 content notes below remain for the owner. To replay the repro, `worker/tools/replay-samples/dp-question.json` needs `--problem vp-0014`, so build content from the owner's `dry_run` checkout first.

Found 2026-10-11 while playtesting `vp-0014` (One or Two Steps) on a debug build, plus an owner report from other sessions.
Worker only. The Flutter app needs no change.

**Bar (owner):** the tutor must behave like a normal conversation partner. A question from the learner gets an answer, not a skip. And the tutor must read what the learner already said before it asks anything.

## Repro session (vp-0014, screenshots)

| # | Who | Text |
|---|---|---|
| 1 | Learner | "I think it's a dynamic programming problem, but I'm not sure if the dynamic programming is an optimized solution or I overengineering it." |
| 2 | Tutor | "What relationship do you think the number of ways for n steps has to the numbers of ways for the previous one-step and two-step cases?" |
| 3 | Learner | "Why you ignored my question? I said it's a tandem programming. So as it is, is there an optimal approach?" (STT turned "dynamic" into "tandem") |
| 4 | Tutor | "Before you decide how many values to keep, can you enumerate all the distinct routes for n = 1 and n = 2 by hand?" |

The learner asked the same question twice and got no answer either time.

## Owner report (no transcript captured)

The learner sends a long message covering the idea **and** its edge cases. The tutor's next message asks about one of those edge cases, or asks a question the message already answered.

---

## Issue 1: the tutor skips the learner's direct questions

### Causes

**1a. Confirmed in code: the abbreviation stays blocked after the learner says the full term.**
`learnerNamedTerms` (`worker/src/lib/ground-truth.ts:76`) unblocks a `never_say` term the learner said, including its spelling variants and its single words. It does not link an abbreviation to its full form. Run against this conversation and `vp-0014`'s content:

```
named:   [ "dynamic programming" ]
blocked: [ "fibonacci", "recurrence", "dp", "memoization", ... ]
"Yes, DP is a good fit here and it isn't overengineering."  -> blocked: ["dp"]
"Dynamic programming is a fine fit here, not overkill."     -> blocked: []
```

The natural answer, "Yes, DP fits…", is blocked. `chat-core.ts` then asks for one rewrite using `rewriteNote` (`worker/src/prompts/tutor.ts`), which ends with "**Ask about the idea without naming it.**" The rewrite does exactly that: it drops the answer and sends only a question. That matches turns 2 and 4.

Not proven for this exact turn, because no transcript is stored. `npm run replay:tutor` can confirm it (see Verification).

**1b. The rewrite note turns an answer into a question.**
Even with 1a fixed, any blocked word in an answer sentence triggers the same note, and the note tells the model to switch from answering to asking.

**1c. The prompt has no rule for direct questions.**
`tutor.ts` covers concept questions ("WHAT YOU MAY ALWAYS DO"), off-topic questions, and requests for the answer. Nothing covers "is my approach good / optimal / overkill?" Meanwhile "Give exactly one nudge per reply" and "Never state a reference approach" push the model towards asking instead of answering.

### Fix

1. **Abbreviations count as named** (`ground-truth.ts`, `learnerNamedTerms`).
   - If a blocked single-word term equals the initials of a named multi-word term, treat it as named: "dp" ↔ "dynamic programming", "bfs" ↔ "breadth first search".
   - Same rule in reverse: a learner who says "dp" unblocks "dynamic programming".
   - Pure code. No content edits.
2. **Rewrite keeps the answer** (`tutor.ts`, `rewriteNote`). Replace the last sentence with:
   > "Keep the same reply — if they asked something, still answer it — just say it without those words."
3. **New prompt section** (`tutor.ts` + `specs/001-proxy-content-contract/contracts/tutor-system-prompt.md`, byte-identical, bump to v8). Insert it before "HOW TO REPLY", so the model reads it first:

   ```
   ANSWER WHAT THEY ASK

   This is a conversation. When their message asks you something, the first sentence of your reply answers it. Never skip a question and never answer a question with an unrelated question.

   If they ask whether their direction is sound, optimal, or overkill, tell them honestly in plain words: "Yes, that fits this problem and it isn't overkill" or "It works, but it will be too slow for these constraints." Judging a direction they named is not giving the answer.

   If an honest answer would hand them the solution itself, say so plainly instead: "That's the heart of the problem, so I'll let you find it, but you're close." Then give your one nudge.
   ```

---

## Issue 2: the tutor re-asks what the learner already covered

The prompt already says "NEVER ASK AGAIN ABOUT SOMETHING THEY HAVE ALREADY ANSWERED" (`tutor.ts`). That instruction is outvoted by four other inputs that tell the model to ask something specific.

### Causes, ranked

**2a. Every reply must be a question, even when nothing is left to ask.**
"Give exactly one nudge per reply" and "move to something they have NOT covered yet" assume something is always uncovered. After a complete message, the model still has to produce a nudge, so it takes one from the ground truth or repeats one.

**2b. Canned edge-case questions in the ground truth.**
`renderGroundTruth` (`ground-truth.ts`) writes every wrong turn as:
`- <text> — if raised for the first time, ask: "<counter_question>"`.
Counter-questions are mostly edge-case probes ("How does your approach handle zero?"). They arrive as ready-made questions with an instruction to ask them, so the model asks them even when the learner has already handled that case.

**2c. The wrap-up sentence forces a repeat.**
From turn 12 of 15, `WRAP_UP_SENTENCE` (`tutor.ts`) says "ask them to state their approach and its complexity", with no condition. A learner who already stated both is asked again.

**2d. Long messages: the model replies to the last sentence.**
A long voice message holds several points. The model tends to answer only its end and treat everything earlier as unsaid.

**2e. Condensation drops handled edge cases.**
After 6 verbatim turns (`trim.verbatim_turns`), older turns become a summary of at most 120 words. The condense prompt keeps "what the learner has claimed or proposed" and the complexity they gave, but not edge cases they handled. Those points vanish, and the tutor asks about them again.

### Fix

1. **Allow "you've covered it"** (tutor prompt, "HOW TO REPLY"). Add:
   > "If their latest message already covers the approach, its edge cases and its complexity, there is nothing left to nudge. Say so plainly, name the one thing they could still tighten if there is one, and tell them they can tap Finish. Do not invent a question to fill the reply."
2. **Make counter-questions conditional** (`ground-truth.ts`, `renderGroundTruth`). Change the line to:
   `- <text> — only if their CURRENT position contains this mistake and they have not already dealt with it, you may ask: "<counter_question>"`
3. **Make the wrap-up conditional** (`tutor.ts`, `WRAP_UP_SENTENCE`):
   > "Begin steering toward a conclusion now. If they have not yet stated their approach and its complexity, ask for them; if they have, tell them they can finish. "
4. **Read the whole message** (tutor prompt, extend the "NEVER ASK AGAIN" paragraph):
   > "Read their whole latest message, not only its last sentence. Every case, step or claim anywhere in it counts as said, and the same goes for everything earlier in the conversation and in the summary of it."
5. **Keep handled edge cases in the summary** (`condense-system-prompt.md` + `prompts/condense.ts`, bump to v2). Add to the "Keep" list, right after the first item:
   > "- edge cases and inputs the learner has already handled, and how"

---

## Issue 3: the tutor must understand what the learner means, not only match words

**Owner requirement:** when the learner says "dynamic programming", says "DP", or speech recognition writes "tandem programming", the system must know it is the same thing. Today the tutor model understands this, but the code around it does not:

- `learnerNamedTerms` decides which words the tutor may use by literal word matching. It can't connect "tandem programming" or an Arabic phrasing to "dynamic programming", or "dynamic programming" to "dp" (1a).
- The voice path transcribes with no hint of what the learner is talking about, so "dynamic" became "tandem" in the first place.

### Fix, in three layers (cheapest first)

1. **Better transcription at the source** (`worker/src/lib/stt-groq.ts`).
   - Whisper takes an optional `prompt` field that biases it towards the spelling of known terms.
   - Send a fixed, generic CS vocabulary string as `prompt`, for example: "dynamic programming, DP, memoization, recursion, hash map, two pointers, sliding window, binary search, BFS, DFS, heap, stack, queue, O(n log n), O(1)".
   - Generic on purpose: no problem id is needed (no app change), and no problem-specific word reaches the transcript that the learner didn't say. Stay under Whisper's 224-token prompt limit.
   - Test: `stt-groq.test.ts` asserts the form carries `prompt`.
   - Covers the Groq voice path only. On-device `speech_to_text` can't be biased; layer 3 covers it.
2. **Acronyms count as named** (Issue 1, fix 1). Deterministic and instant, so it applies on the same turn.
3. **The progress check also reports which terms the learner referred to** (`worker/src/lib/finish-check.ts` + `specs/005-finish-offer/contracts/finish-check-system-prompt.md` v3).
   - This model call already runs alongside every tutor turn. It already reads only the learner's words, and it handles paraphrase, Egyptian Arabic and mangled speech (98% in review F4).
   - Add a second field, `named`: an enum of the problem's `never_say` terms. It lists every term the learner referred to in any form: full form, abbreviation, mispronunciation, or another language.
   - Store it next to `reachedKeys` and merge it into `named` in `chat-core.ts` before `buildBlockedTerms`.
   - Like `reached`, it applies from the **next** turn, because the check runs in parallel with the reply. Layer 2 covers the current turn.
   - No new provider call.
   - Dependency: the check only runs when `finish_offer.enabled` is true (`chat-core.ts`). Either confirm it is on in every environment, or decouple: run the check whenever `deps.finishCheck` exists, and gate only the offer on `enabled`.
   - Guard: `named` may only unblock words. It never marks an insight reached.

---

## Content notes for vp-0014 (fix in the `dry_run` content repo, not here)

`vp-0014` lives in `Abdelmohaymn/dry_run` (`content/problems/vp-0014.json`) and is not tracked in this repo. Notes from this session:

1. **Turn 4 was a canned counter-question.** "Can you enumerate all the distinct routes for n = 1 and n = 2 by hand?" is `common_wrong_turns.wrong_base_case.counter_question`, nearly word for word. The learner made no base-case mistake. The code fix is 2b. On the content side, the question is generic enough to fire as an opener; consider tying its wording to the actual mistake (a wrong value for n = 1 or n = 2).
2. **`last_move_split.never_say` lists both "dp" and "dynamic programming".** That's correct (don't name the approach first), but it is exactly the pair that blocked the answer in 1a. No content change needed once fix 1 lands.
3. **`public.glossary_terms` includes "memoization", "Fibonacci" and "dynamic programming".** These are `never_say` terms, and they appear in the public manifest any learner's app downloads. They power the tap-to-fix chips, which are harmless, but the list itself names the solution family. Owner's call whether to keep them public.

---

## Verification

1. **Confirm 1a on the real model before changing anything** (owner, needs a key):
   - Save turns 1–3 above as `worker/tools/replay-samples/dp-question.json`.
   - `GROQ_API_KEY=… npm run replay:tutor -- tools/replay-samples/dp-question.json --problem vp-0014 --runs 6`
   - The report shows how many drafts were blocked on `dp` and rewritten into a bare question.
   - Re-run after the fix and expect the reply to start with an answer.
2. **Unit tests** (`npm test`):
   - `learnerNamedTerms`: "dynamic programming" names "dp"; "dp" names "dynamic programming"; "dynamic" alone does not name "dp".
   - `renderGroundTruth`: the counter-question line carries the "only if" condition.
   - `prompts-verbatim.test.ts`: tutor v8 and condense v2 match their contract files.
3. **Harness regressions** (`worker/test/harness/corpus/tutor/`). Corpora exist only for the seed problems vp-0000 to vp-0003, so port the two cases to a seed problem:
   - **Question answered:** the learner asks "is a hash map optimal here or am I overengineering?" Add a `must_answer: true` field to the regression case schema. The harness asserts the reply's first sentence does not end in "?".
   - **Covered edge case not re-asked:** one long learner message stating the approach, its complexity and the problem's authored edge cases. `must_not_match` lists each edge case's counter-question.
4. **Change control:** any tutor prompt diff requires the full tutor harness (`npm run test:harness`), per `tutor-system-prompt.md`.

## Files touched

- `worker/src/lib/ground-truth.ts` (`learnerNamedTerms`, `renderGroundTruth`)
- `worker/src/lib/stt-groq.ts` (Whisper `prompt`)
- `worker/src/lib/finish-check.ts`, `worker/src/lib/chat-core.ts`, `worker/src/lib/turn-cap.ts` (store and merge `named`) + `specs/005-finish-offer/contracts/finish-check-system-prompt.md` (v3)
- `worker/src/prompts/tutor.ts` + `specs/001-proxy-content-contract/contracts/tutor-system-prompt.md` (v8, `rewriteNote`, `WRAP_UP_SENTENCE`)
- `worker/src/prompts/condense.ts` + `specs/001-proxy-content-contract/contracts/condense-system-prompt.md` (v2)
- `worker/tools/replay-samples/dp-question.json` (new)
- `worker/test/harness/tutor.harness.test.ts` (`must_answer`), tutor corpus, `worker/test/unit/` tests above

## Out of scope

- **Giving the tutor the "reached insights" list again.** It was removed in review F1 (2026-10-07) because the tutor then steered learners on valid unlisted approaches towards the reference one. Fix 2 works without it.
- **The question that gave away `last_move_split` (turn 2).** It's a separate leak issue: a paraphrase the word filter can't catch. Track it on its own.

## Estimate

About 5–6 hours, plus a harness run by the owner:
- Issues 1 and 2: 3–4 hours, mostly prompt wording and the two harness regressions.
- Issue 3: 2 hours. Layer 3 needs a place to store `named`; check whether `device_day` needs a migration or can reuse the `reachedKeys` column's storage pattern.
