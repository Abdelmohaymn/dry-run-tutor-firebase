// The staged twin of runJudge (judge-core.ts) for the step protocol
// (contracts/relay-steps.md §POST /v2/judge). Same prompts and post-processing;
// every model call goes through a StepPort and each stage ends in a barrier.
// No D1 access: the route reads the session up front and claims the judge only
// once an assessment exists.
import { AppError } from "./errors";
import type { JudgeRequest, Turn } from "./schemas";
import { judgeSlice, renderJudgeGroundTruth } from "./ground-truth";
import { buildJudgeSchema } from "./judge-schema";
import {
  isSelfContradictory,
  parseJudgeOutput,
  postprocessJudge,
  type Assessment,
  type SettledInsights,
} from "./judge-postprocess";
import { runFinishCheck } from "./finish-check";
import { gatherEvidence, verifySettled } from "./judge-evidence";
import { JUDGE_CONVERSATION_PLACEHOLDER, renderConversation, renderSettled } from "./judge-core";
import { JUDGE_PROMPT } from "../prompts/judge";
import { NeedModel, settle, type StepPort } from "./step-port";
import type { Problem } from "../../../tools/problem-types";

export async function runJudgeSteps(body: JudgeRequest, problem: Problem, port: StepPort): Promise<Assessment> {
  // A solution-ended session is graded on the conversation as it stood before the reveal.
  const conversation: Turn[] =
    body.ended_by === "solution" ? body.conversation.slice(0, body.reveal_at_index!) : body.conversation;

  const learnerTurns = conversation.flatMap((t, i) =>
    t.role === "user" ? [{ text: t.text, asked: conversation[i - 1]?.role === "tutor" ? conversation[i - 1].text : null }] : [],
  );

  // ---- J1: the progress check on the judged conversation ----
  const final = await runFinishCheck(problem, conversation, port.asStructuredCall("progress"));
  port.barrier();

  // ---- J2: the support check on its quotes (only if J1 found evidence) ----
  const verified = final ? await verifySettled(final.evidence, learnerTurns, problem, port.asStructuredCall("evidence")) : null;
  port.barrier();
  const settled: SettledInsights | undefined = verified
    ? { hit: [...verified.reached, ...verified.assisted], assisted: verified.assisted }
    : undefined;

  const groundTruthText = renderJudgeGroundTruth(judgeSlice(problem));
  const systemPrompt = JUDGE_PROMPT.replace("{{GROUND_TRUTH}}", groundTruthText).replace(
    "{{CONVERSATION}}",
    JUDGE_CONVERSATION_PLACEHOLDER,
  );
  const settledBlock = verified ? `${renderSettled(problem, verified.reached, verified.assisted)}\n\n` : "";
  const userContent = `${renderConversation(conversation)}\n\n${settledBlock}Return the assessment now.`;
  const schema = buildJudgeSchema(problem);

  try {
    // ---- J3: the assessment (required) ----
    const first = await settle(port.json("judge", systemPrompt, userContent, schema, { required: true }));
    port.barrier();
    if (!first.ok) throw first.error;
    let raw = first.value;

    // ---- J4: one more ask when the answer contradicts itself (optional) ----
    if (isSelfContradictory(postprocessJudge(raw, problem, undefined, settled).assessment, problem)) {
      try {
        const second = await port.json("judge", systemPrompt, userContent, schema, { attempt: 2 });
        if (!isSelfContradictory(postprocessJudge(second, problem, undefined, settled).assessment, problem)) raw = second;
      } catch {
        // Pending (the barrier below asks for it) or failed: the first answer stands.
      }
      port.barrier();
    }

    // ---- J5: provenance + support on whichever answer was kept ----
    const parsed = parseJudgeOutput(raw);
    const evidence = await gatherEvidence(
      settled ? { ...parsed, insights_hit: [] } : parsed,
      learnerTurns,
      problem,
      port.asStructuredCall("evidence"),
    );
    port.barrier();
    return postprocessJudge(raw, problem, evidence, settled).assessment;
  } catch (err) {
    if (err instanceof NeedModel) throw err;
    throw err instanceof AppError ? err : new AppError("UNCLEAR_RETRY");
  }
}
