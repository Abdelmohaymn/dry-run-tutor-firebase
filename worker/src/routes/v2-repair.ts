// POST /v2/repair — contracts/relay-steps.md. Corrects speech-recognition
// errors in one spoken transcript over the step protocol; one `repair` call,
// then the same three guards as v1. Reserves no turn.
import { Hono } from "hono";
import type { Env, Variables } from "../types";
import { AppError } from "../lib/errors";
import { repairStepRequestSchema } from "../lib/schemas";
import { getPrivate, getPublicManifest } from "../lib/content";
import { getRuntimeConfig } from "../lib/runtime-config";
import { modelResponse, readStepBody } from "../lib/step-route";
import { NeedModel, StepPort, settle } from "../lib/step-port";
import { callRepairProvider, containsNoGroundTruth, retainsLearnerWords, withinLengthRatio } from "../lib/repair";

export const v2RepairRoute = new Hono<{ Bindings: Env; Variables: Variables }>();

v2RepairRoute.post("/", async (c) => {
  const { request: body, answers } = await readStepBody(c, repairStepRequestSchema);

  const publicEntry = getPublicManifest().problems.find((p) => p.id === body.problem_id);
  if (!publicEntry) throw new AppError("BAD_REQUEST");

  const cfg = await getRuntimeConfig(c.env.DB);
  if (cfg.killed_problem_ids.includes(body.problem_id)) throw new AppError("PROBLEM_KILLED");

  const unchanged = () => c.json({ status: "done", repaired: body.transcript, changed: false }, 200);

  // Skip checks: nothing to spend, so no model call.
  const denseChars = body.transcript.replace(/\s/g, "").length;
  if (
    cfg.repair === undefined ||
    cfg.repair.enabled === false ||
    denseChars < cfg.repair.min_chars ||
    body.transcript.length > cfg.repair.max_input_chars
  ) {
    return unchanged();
  }

  const port = new StepPort(answers, cfg);
  let called;
  try {
    // callRepairProvider rethrows anything that is not an AppError, which includes
    // an unanswered call: settle it, then let the barrier ask for the answer.
    const attempt = await settle(callRepairProvider({
      provider: port.asProvider("repair", { required: true }),
      baseUrl: "",
      apiKey: "",
      model: cfg.gemini.models.repair,
      glossaryTerms: publicEntry.glossary_terms,
      transcript: body.transcript,
      timeoutMs: cfg.repair.timeout_ms,
    }));
    port.barrier();
    if (!attempt.ok) throw attempt.error;
    called = attempt.value;
  } catch (err) {
    if (err instanceof NeedModel) return modelResponse(c, err);
    throw err;
  }
  if (port.unused().length > 0) throw new AppError("STEP_DIVERGED");
  if (called === null) return unchanged();

  // Guard 2's blocked terms are built here, from the private half, after the
  // model has answered — never before, never into the prompt (FR-009).
  const privateHalf = getPrivate(body.problem_id);
  const blockedTerms = privateHalf
    ? [...new Set(privateHalf.key_insights.flatMap((i) => i.never_say.map((t) => t.toLowerCase())))]
    : [];

  const guardsPassed =
    withinLengthRatio(body.transcript, called.text, cfg.repair.max_output_ratio) &&
    containsNoGroundTruth(called.text, blockedTerms) &&
    retainsLearnerWords(body.transcript, called.text, cfg.repair.min_word_overlap);

  const repaired = guardsPassed ? called.text : body.transcript;
  return c.json({ status: "done", repaired, changed: repaired !== body.transcript }, 200);
});
