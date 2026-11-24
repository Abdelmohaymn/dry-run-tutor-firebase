// POST /v2/turn — contracts/relay-steps.md. One tutor turn over the step
// protocol: the relay never calls a model, it returns the calls it needs
// (`status: "model"`) and the app re-POSTs with the answers. No D1 write
// happens before the final step; the turn is committed once, idempotent per
// `turn_key`, when the checked reply is ready.
import { Hono } from "hono";
import type { Env, Variables } from "../types";
import { AppError } from "../lib/errors";
import { turnStepRequestSchema } from "../lib/schemas";
import { isPracticeProblem } from "../lib/content";
import { getRuntimeConfig } from "../lib/runtime-config";
import { modelResponse, readStepBody, requireProblem } from "../lib/step-route";
import { NeedModel, StepPort } from "../lib/step-port";
import { buildTurnMeta, runTurnSteps, type TurnStepInput } from "../lib/turn-pipeline";
import {
  assertNotJudged,
  commitTurn,
  planReservation,
  readSessionState,
  recordAssistedKeys,
  recordNamedTerms,
  recordReachedKeys,
  releaseSolution,
  revealNextHint,
  type PlannedReservation,
  type TurnCounterKey,
} from "../lib/turn-cap";
import { LADDER_EXHAUSTED, flatLadder, nextHint } from "../lib/hint-ladder";
import { LADDER_EXHAUSTED_LINE } from "../prompts/tutor";
import type { MetaFramePayload } from "../lib/sse";
import { utcDate } from "../lib/time";

export const v2TurnRoute = new Hono<{ Bindings: Env; Variables: Variables }>();

v2TurnRoute.post("/", async (c) => {
  const installId = c.get("installId");
  const { turn_key: turnKey, request: body, answers } = await readStepBody(c, turnStepRequestSchema);
  const problem = requireProblem(body.problem_id);

  const db = c.env.DB;
  const cfg = await getRuntimeConfig(db);
  const date = utcDate();
  const key: TurnCounterKey = { installId, problemId: body.problem_id, date };

  if (cfg.killed_problem_ids.includes(body.problem_id)) throw new AppError("PROBLEM_KILLED");

  const practice = isPracticeProblem(body.problem_id);
  const cap = practice ? cfg.trial.practice_turn_cap : cfg.chat.turn_cap;

  // ---- Hint branch: no model call, no turn spent (FR-003a, FR-003b). ----
  if (body.hint_requested) {
    const state = await readSessionState(db, key);
    assertNotJudged(state.judgedAt);
    const hintsRevealed = await revealNextHint(db, key);
    const rung = nextHint(problem, hintsRevealed);
    const meta: MetaFramePayload = {
      turn_index: state.turns,
      turns_remaining: Math.max(0, cap - state.turns),
      hints_revealed: hintsRevealed,
      hints_remaining: Math.max(0, flatLadder(problem).length - hintsRevealed),
      session_ended: null,
      leak_blocked: false,
    };
    return c.json({ status: "done", reply: rung === LADDER_EXHAUSTED ? LADDER_EXHAUSTED_LINE : rung.text, meta }, 200);
  }

  // ---- Guards, before any model call, as v1. ----
  if (turnKey === undefined) throw new AppError("BAD_REQUEST");
  const lastMessage = body.messages[body.messages.length - 1];
  if (lastMessage.text.replace(/\s+/g, "").length < cfg.chat.min_turn_chars) {
    throw new AppError("EMPTY_TURN");
  }

  const state = await readSessionState(db, key);
  assertNotJudged(state.judgedAt);

  // A retry of a turn that already committed spends nothing: plan with the
  // index it got (data-model.md §R1).
  const replay = state.lastTurnKey === turnKey && state.lastTurnIndex !== null;
  const planned: PlannedReservation = replay
    ? { turnIndex: state.lastTurnIndex!, solutionRequests: state.solutionRequests }
    : planReservation(state, cap, body.solution_request_count);

  const released = releaseSolution(planned.turnIndex, planned.solutionRequests);
  const turnsRemaining = Math.max(0, cap - planned.turnIndex);
  const sessionEnded: "cap" | "solution" | null = released ? "solution" : planned.turnIndex >= cap ? "cap" : null;

  const input: TurnStepInput = {
    body,
    problem,
    cfg,
    counters: { reachedKeys: state.reachedKeys, assistedKeys: state.assistedKeys, namedTerms: state.namedTerms },
    planned,
    released,
    sessionEnded,
    turnsRemaining,
    offlineNote: body.offline_note,
    practice,
  };

  const port = new StepPort(answers, cfg);
  let result;
  try {
    result = await runTurnSteps(input, port);
  } catch (err) {
    if (err instanceof NeedModel) return modelResponse(c, err);
    throw err;
  }
  if (port.unused().length > 0) throw new AppError("STEP_DIVERGED");

  // ---- Commit: the only D1 write of the whole loop. ----
  const committed = await commitTurn(db, key, cap, body.solution_request_count, turnKey, planned.turnIndex);
  if (result.checked) {
    await recordReachedKeys(db, key, state.reachedKeys, result.checked.reached);
    await recordAssistedKeys(db, key, state.assistedKeys, result.checked.assisted);
    await recordNamedTerms(db, key, state.namedTerms, result.checked.named);
  }

  return c.json({ status: "done", reply: result.reply, meta: buildTurnMeta(input, result, committed.hintsRevealed) }, 200);
});
