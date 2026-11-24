// The staged twin of runConversationalTurn (chat-core.ts) for the step
// protocol (contracts/relay-steps.md §POST /v2/turn). Same prompts, same
// filter, same finish check — but every model call goes through a StepPort, so
// the relay asks the app for the answers instead of calling a model. Each
// stage ends with port.barrier(): if any call of the stage is unanswered the
// whole pipeline unwinds with NeedModel and the next POST re-runs it from the
// top. No D1 access in here — counters come in, the route commits at the end.
import { AppError } from "./errors";
import type { ChatRequest, Turn } from "./schemas";
import type { RuntimeConfig } from "./runtime-config";
import type { PlannedReservation } from "./turn-cap";
import { learnerNamedTerms, renderGroundTruth, selectSlice } from "./ground-truth";
import { isReady, runFinishCheck, type FinishCheckResult } from "./finish-check";
import { condense, type CondenseResult } from "./condense";
import { blockedTermsIn, buildBlockedTerms, cleanLead } from "./leak-filter";
import { flatLadder } from "./hint-ladder";
import { LEAK_BLOCKED_FALLBACK, TUTOR_PROMPT, WRAP_UP_SENTENCE, rewriteNote } from "../prompts/tutor";
import { withReplyLanguageNote, withSolutionReleaseNote } from "./reply-language";
import type { ProviderMessage } from "./provider";
import type { MetaFramePayload } from "./sse";
import { settle, type StepPort } from "./step-port";
import type { Problem } from "../../../tools/problem-types";

export interface TurnStepInput {
  body: ChatRequest;
  problem: Problem;
  cfg: RuntimeConfig;
  /** What the session has earned so far, read from D1 before the step. */
  counters: { reachedKeys: string[]; assistedKeys: string[]; namedTerms: string[] };
  planned: PlannedReservation;
  released: boolean;
  sessionEnded: "cap" | "solution" | null;
  turnsRemaining: number;
  /** Learner-only quotes from offline turns since the last online turn (≤ 600 chars). */
  offlineNote?: string;
  /** The onboarding walkthrough: no condensation, no progress check, trial ground-truth tier. */
  practice?: boolean;
}

export interface TurnStepResult {
  reply: string;
  fallbackSent: boolean;
  condensed: CondenseResult;
  /** This turn's progress check, null when it did not run or failed. */
  checked: FinishCheckResult | null;
  /** Whether a progress check was asked for this turn (v1: `finishCheck` was non-null). */
  checkRan: boolean;
  /** `turn_index >= finish_offer.min_turn`. */
  offerOpen: boolean;
}

export async function runTurnSteps(input: TurnStepInput, port: StepPort): Promise<TurnStepResult> {
  const { body, problem, cfg, counters, planned, released, sessionEnded, turnsRemaining } = input;
  const practice = input.practice === true;

  // ---- S1: condense (optional; a failure leaves the history as it was) ----
  let condensed: CondenseResult = { summary: body.summary, verbatim: body.messages, called: false, covered: 0 };
  if (!practice) {
    const attempt = await settle(
      condense(body.summary, body.messages, cfg, port.asProvider("condense"), {
        baseUrl: "",
        apiKey: "",
        model: cfg.gemini.models.condense,
      }),
    );
    port.barrier();
    if (attempt.ok) condensed = attempt.value;
  }

  // What the learner has said this session (see chat-core.ts for why both parts).
  const learnerHistory: Turn[] = [
    ...(body.earlier_learner_turns ?? []).map((text) => ({ role: "user" as const, text })),
    ...body.messages,
  ];
  const slice = selectSlice(
    problem,
    learnerHistory,
    planned.turnIndex,
    cfg,
    practice ? cfg.trial.ground_truth_tier : "AB",
  );
  const groundTruthText = renderGroundTruth(slice);
  const wrapUp = planned.turnIndex >= cfg.chat.wrap_up_at_turn ? WRAP_UP_SENTENCE : "";
  const systemPrompt = TUTOR_PROMPT.replace("{{SOLUTION_REQUEST_COUNT}}", String(planned.solutionRequests))
    .replace("{{TURNS_REMAINING}}", String(turnsRemaining))
    .replace("{{WRAP_UP}}", wrapUp)
    .replace("{{GROUND_TRUTH}}", groundTruthText);

  // Summary line first, then the offline note (FR-011a), then the replayed turns.
  const lead: ProviderMessage[] = [];
  if (condensed.summary) {
    lead.push({ role: "user", text: `[Context from earlier in this conversation: ${condensed.summary}]` });
  }
  if (input.offlineNote) {
    lead.push({ role: "user", text: `[While offline, the learner said: ${input.offlineNote}]` });
  }
  const withNotes = withReplyLanguageNote(lead.length > 0 ? [...lead, ...condensed.verbatim] : condensed.verbatim);
  const providerMessages: ProviderMessage[] = released ? withSolutionReleaseNote(withNotes) : withNotes;

  // ---- S2: tutor draft ∥ progress check ----
  const finishOffer = cfg.finish_offer;
  const checkRan = !practice && finishOffer.enabled && sessionEnded === null;
  const offerOpen = planned.turnIndex >= finishOffer.min_turn;

  const [tutor, check] = await Promise.all([
    settle(port.text("tutor", systemPrompt, providerMessages, { required: true })),
    checkRan
      ? runFinishCheck(problem, learnerHistory, port.asStructuredCall("progress"))
      : Promise.resolve<FinishCheckResult | null>(null),
  ]);
  port.barrier();
  if (!tutor.ok) throw tutor.error instanceof AppError ? tutor.error : new AppError("UNCLEAR_RETRY");
  const firstText = tutor.value;

  const reachedKeys = new Set(counters.reachedKeys);
  const named = new Set([...learnerNamedTerms(problem, learnerHistory), ...counters.namedTerms]);
  const blockedTerms = buildBlockedTerms(problem, reachedKeys, named, released ? "solution" : null);

  // A draft blocked only by words for ideas the learner stated THIS turn is let
  // through: this turn's check rebuilds the blocked set (as v1's early unblock).
  let activeBlocked = blockedTerms;
  let hits = blockedTermsIn(firstText, activeBlocked);
  if (hits.length > 0 && check) {
    activeBlocked = buildBlockedTerms(
      problem,
      new Set([...reachedKeys, ...check.reached]),
      new Set([...named, ...check.named]),
      released ? "solution" : null,
    );
    hits = blockedTermsIn(firstText, activeBlocked);
  }

  // ---- S3: one rewrite when the draft still names a blocked word ----
  let reply = firstText;
  let fallbackSent = false;
  if (hits.length > 0) {
    const second = await settle(port.text("rewrite", systemPrompt + rewriteNote(hits), providerMessages));
    port.barrier();
    const rewrite =
      second.ok && second.value.trim() !== "" && blockedTermsIn(second.value, activeBlocked).length === 0
        ? second.value
        : null;
    const cleanFirst = cleanLead(firstText, activeBlocked);
    reply = rewrite ?? (cleanFirst.trim() !== "" ? cleanFirst : LEAK_BLOCKED_FALLBACK);
    fallbackSent = rewrite === null && cleanFirst.trim() === "";
  }

  if (reply.trim() === "") throw new AppError("UNCLEAR_RETRY");

  return { reply, fallbackSent, condensed, checked: check, checkRan, offerOpen };
}

/** The union of earlier and this turn's keys, as v1 stored and reported them. */
export function reachedAndAssisted(
  counters: TurnStepInput["counters"],
  checked: FinishCheckResult | null,
): { reachedNow: string[]; assistedNow: string[] } {
  return {
    reachedNow: [...new Set([...counters.reachedKeys, ...(checked?.reached ?? [])])],
    assistedNow: [...new Set([...counters.assistedKeys, ...(checked?.assisted ?? [])])],
  };
}

/** The v1 meta frame, byte for byte, for a finished step. */
export function buildTurnMeta(
  input: TurnStepInput,
  result: TurnStepResult,
  hintsRevealed: number,
): MetaFramePayload {
  const { reachedNow, assistedNow } = reachedAndAssisted(input.counters, result.checked);
  return {
    turn_index: input.planned.turnIndex,
    turns_remaining: input.turnsRemaining,
    hints_revealed: hintsRevealed,
    hints_remaining: Math.max(0, flatLadder(input.problem).length - hintsRevealed),
    summary: result.condensed.called ? (result.condensed.summary ?? null) : undefined,
    summary_covers: result.condensed.called ? result.condensed.covered : undefined,
    session_ended: input.sessionEnded,
    leak_blocked: result.fallbackSent,
    ready_to_finish:
      result.checkRan && result.offerOpen && !input.body.finish_offer_dismissed
        ? isReady(input.problem, [...reachedNow, ...assistedNow])
        : undefined,
  };
}
