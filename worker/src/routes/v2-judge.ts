// POST /v2/judge — contracts/relay-steps.md. One assessment per session over the
// step protocol. The session is checked read-only up front and claimed
// (atomically) only once the assessment exists, so an abandoned loop leaves
// the session unjudged (Constitution VIII).
import { Hono } from "hono";
import type { Env, Variables } from "../types";
import { AppError } from "../lib/errors";
import { judgeStepRequestSchema } from "../lib/schemas";
import { getRuntimeConfig } from "../lib/runtime-config";
import { modelResponse, readStepBody, requireProblem } from "../lib/step-route";
import { NeedModel, StepPort } from "../lib/step-port";
import { runJudgeSteps } from "../lib/judge-pipeline";
import { assertNotJudged, claimJudge, readSessionState, type TurnCounterKey } from "../lib/turn-cap";
import { utcDate } from "../lib/time";

export const v2JudgeRoute = new Hono<{ Bindings: Env; Variables: Variables }>();

v2JudgeRoute.post("/", async (c) => {
  const installId = c.get("installId");
  const { request: body, answers } = await readStepBody(c, judgeStepRequestSchema);

  // FR-021: a solution-ended session must name where the reveal happened.
  if (body.ended_by === "solution" && body.reveal_at_index === undefined) throw new AppError("BAD_REQUEST");

  const problem = requireProblem(body.problem_id);
  const db = c.env.DB;
  const cfg = await getRuntimeConfig(db);
  if (cfg.killed_problem_ids.includes(body.problem_id)) throw new AppError("PROBLEM_KILLED");

  const key: TurnCounterKey = { installId, problemId: body.problem_id, date: utcDate() };
  assertNotJudged((await readSessionState(db, key)).judgedAt);

  const port = new StepPort(answers, cfg);
  let assessment;
  try {
    assessment = await runJudgeSteps(body, problem, port);
  } catch (err) {
    if (err instanceof NeedModel) return modelResponse(c, err);
    throw err;
  }
  if (port.unused().length > 0) throw new AppError("STEP_DIVERGED");

  await claimJudge(db, key); // lost claim → SESSION_ALREADY_JUDGED
  return c.json({ status: "done", assessment }, 200);
});
