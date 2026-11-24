// The "fake app" of the live harness (research.md R9): drives /v2/turn and
// /v2/judge through SELF.fetch and answers every ModelCall the relay asks for by
// calling Gemini over its OpenAI-compatible endpoint with GEMINI_API_KEY —
// the same model, prompts and checks a phone runs through Firebase AI Logic,
// minus the SDK. fetchMock is never activated here: requests go out for real.
import { env, SELF } from "cloudflare:test";
import type { Answers, ModelAnswer, ModelCall } from "../../../src/lib/step-port";

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";

/** Ids used when GEMINI_MODEL_FLASH / GEMINI_MODEL_LITE are not set (research.md R3). */
const DEFAULT_FLASH = "gemini-3.8-flash";
const DEFAULT_LITE = "gemini-3.5-flash-lite";

export function requireGeminiApiKey(): string {
  const key = env.GEMINI_API_KEY;
  if (!key) {
    throw new Error("GEMINI_API_KEY is not set. worker/test/harness/** makes live Gemini calls and must not run without it.");
  }
  return key;
}

/** Points the relay config's `gemini.models` at the ids this run measures, and turns the finish offer on as production has it. */
export async function applyGeminiConfig(db: D1Database): Promise<void> {
  const flash = env.GEMINI_MODEL_FLASH || DEFAULT_FLASH;
  const lite = env.GEMINI_MODEL_LITE || DEFAULT_LITE;
  const row = await db.prepare("SELECT payload FROM config WHERE id = 1").first<{ payload: string }>();
  if (!row) return;
  const cfg = JSON.parse(row.payload);
  cfg.gemini.models = {
    tutor: flash,
    rewrite: flash,
    judge: flash,
    progress: lite,
    evidence: lite,
    condense: lite,
    repair: lite,
  };
  cfg.finish_offer = { min_turn: 1, timeout_ms: 8000, ...(cfg.finish_offer ?? {}), enabled: true };
  await db.prepare("UPDATE config SET payload = ?1 WHERE id = 1").bind(JSON.stringify(cfg)).run();
}

export async function mintInstallId(): Promise<string> {
  const res = await SELF.fetch("https://worker.test/v1/install", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ platform: "android", device_id: crypto.randomUUID().replace(/-/g, "").slice(0, 16) }),
  });
  return ((await res.json()) as { install_id: string }).install_id;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callGemini(call: ModelCall, withReasoningControl: boolean, retried = false): Promise<ModelAnswer> {
  const body: Record<string, unknown> = {
    model: call.model,
    messages: [
      { role: "system", content: call.system },
      ...call.messages.map((m) => ({ role: m.role === "model" ? "assistant" : "user", content: m.text })),
    ],
    max_tokens: call.max_output_tokens,
    temperature: call.temperature,
  };
  if (call.output.kind === "json") {
    body.response_format = { type: "json_schema", json_schema: { name: "result", schema: call.output.schema } };
  }
  if (withReasoningControl && call.thinking_budget === 0) body.reasoning_effort = "none";

  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${requireGeminiApiKey()}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(call.timeout_ms),
    });
  } catch {
    return { error: "timeout" };
  }

  if (res.status === 400 && withReasoningControl && call.thinking_budget === 0) {
    // A model that cannot switch thinking off: ask again without the control.
    return callGemini(call, false, retried);
  }
  if (res.status === 429) {
    if (!retried) {
      await sleep(6000);
      return callGemini(call, withReasoningControl, true);
    }
    return { error: "rate_limited" };
  }
  if (!res.ok) return { error: res.status >= 500 ? "unavailable" : "other" };

  const data = (await res.json()) as { choices?: { message?: { content?: string | null } }[] };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim() === "") return { error: "blocked" };
  if (call.output.kind === "text") return { text: content };
  try {
    return { json: JSON.parse(content) };
  } catch {
    return { error: "bad_output" };
  }
}

export interface StepOutcome {
  status: number;
  body: any;
  /** How many model calls the loop made, per purpose. */
  calls: Record<string, number>;
}

/** Plays the app's loop (≤ 6 POSTs): POST, answer the calls with Gemini, POST again. */
export async function runLoop(path: string, installId: string, payload: Record<string, unknown>): Promise<StepOutcome> {
  const calls: Record<string, number> = {};
  let answers: Answers = {};
  for (let posts = 1; posts <= 6; posts++) {
    const res = await SELF.fetch(`https://worker.test${path}`, {
      method: "POST",
      headers: { "X-Install-Id": installId, "content-type": "application/json" },
      body: JSON.stringify({ ...payload, answers }),
    });
    const body = (await res.json()) as any;
    if (res.status !== 200 || body.status !== "model") return { status: res.status, body, calls };
    const asked = body.calls as ModelCall[];
    const results = await Promise.all(asked.map((c) => callGemini(c, true)));
    asked.forEach((c, i) => {
      calls[c.purpose] = (calls[c.purpose] ?? 0) + 1;
      const result = results[i];
      // The app stops the loop when a required call fails; the harness reports it as an error.
      if ("error" in result && c.required) throw new Error(`required ${c.purpose} call failed: ${result.error}`);
      answers = { ...answers, [c.id]: result };
    });
  }
  return { status: 502, body: { error: { code: "UNCLEAR_RETRY" } }, calls };
}

export interface Turn {
  role: "user" | "tutor";
  text: string;
}

export interface LiveChatResult {
  replyText: string;
  leakBlocked: boolean;
  sessionEnded: string | null;
  turnIndex: number;
  /** Set when the turn came back as an error (the caller's cue to back off and retry). */
  errorRetryAfterMs?: number;
}

/** One live /v2/turn through the whole step loop. */
export async function sendChatTurn(
  installId: string,
  problemId: string,
  messages: Turn[],
  solutionRequestCount?: number,
): Promise<LiveChatResult> {
  let outcome: StepOutcome;
  try {
    outcome = await runLoop("/v2/turn", installId, {
      turn_key: crypto.randomUUID(),
      request: { problem_id: problemId, messages, solution_request_count: solutionRequestCount },
    });
  } catch {
    return { replyText: "", leakBlocked: false, sessionEnded: null, turnIndex: 0, errorRetryAfterMs: 6000 };
  }
  if (outcome.body.status !== "done") {
    return { replyText: "", leakBlocked: false, sessionEnded: null, turnIndex: 0, errorRetryAfterMs: 4000 };
  }
  const meta = outcome.body.meta as { session_ended: string | null; turn_index: number; leak_blocked: boolean };
  return {
    replyText: outcome.body.reply,
    leakBlocked: meta.leak_blocked,
    sessionEnded: meta.session_ended,
    turnIndex: meta.turn_index,
  };
}

const MAX_RETRY_WAIT_MS = 45_000;

/** A whole scripted conversation (learner turns only) against one fresh session; retries a failed turn once. */
export async function runConversation(problemId: string, learnerTurns: string[]): Promise<LiveChatResult[]> {
  const installId = await mintInstallId();
  const conversation: Turn[] = [];
  const results: LiveChatResult[] = [];
  for (const text of learnerTurns) {
    conversation.push({ role: "user", text });
    let result = await sendChatTurn(installId, problemId, conversation);
    if (result.replyText.length === 0) {
      await sleep(Math.min(result.errorRetryAfterMs ?? 4000, MAX_RETRY_WAIT_MS));
      result = await sendChatTurn(installId, problemId, conversation);
    }
    conversation.push({ role: "tutor", text: result.replyText });
    results.push(result);
    await sleep(800);
  }
  return results;
}

/** One live /v2/judge; returns the assessment, or `{ error }` on a failed loop. */
export async function requestAssessment(problemId: string, conversation: Turn[]): Promise<Record<string, unknown>> {
  try {
    const outcome = await runLoop("/v2/judge", await mintInstallId(), {
      request: { problem_id: problemId, conversation, ended_by: "user" },
    });
    return outcome.body.status === "done" ? outcome.body.assessment : { error: outcome.body.error ?? { code: "UNCLEAR_RETRY" } };
  } catch (err) {
    return { error: { code: "UNCLEAR_RETRY", detail: String(err), retry_after_ms: 6000 } };
  }
}
