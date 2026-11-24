// data-model.md §R2, contracts/relay-steps.md. The relay never calls a model:
// every model call the pipeline wants is described as a `ModelCall`; the app
// runs it through Firebase AI Logic and sends the answer back on the next POST.
// `StepPort` is the seam: a call whose answer is present resolves; an
// unanswered call is recorded as pending and rejects with `PendingCall`.
// Stage code calls `barrier()` after each stage — helpers reused from the v1
// pipeline swallow errors and return null, so a null before a barrier means
// "not answered yet", never "failed".
import { AppError } from "./errors";
import { toGeminiSchema, type GeminiSchema } from "./gemini-schema";
import type { Provider, StructuredCompletionParams, StructuredCompletionResult } from "./provider";
import { geminiCallOpts, type Purpose, type RuntimeConfig } from "./runtime-config";

export type { Purpose } from "./runtime-config";

export type AnswerError = "rate_limited" | "unavailable" | "timeout" | "blocked" | "bad_output" | "other";

export interface ModelCall {
  id: string;
  purpose: Purpose;
  model: string;
  system: string;
  messages: { role: "user" | "model"; text: string }[];
  output: { kind: "text" } | { kind: "json"; schema: GeminiSchema };
  max_output_tokens: number;
  temperature: number;
  thinking_budget: number | null;
  timeout_ms: number;
  required: boolean;
  /** Distinguishes a repeat of an otherwise identical call (judge second ask). */
  attempt?: number;
}

export type ModelAnswer = { text: string } | { json: unknown } | { error: AnswerError };
export type Answers = Record<string, ModelAnswer>;

export type StepMessage = { role: "user" | "tutor" | "model"; text: string };

export interface StepCallExtra {
  required?: boolean;
  attempt?: number;
}

/** Thrown by an unanswered call. Stage code lets it propagate to `barrier()`. */
export class PendingCall extends Error {
  constructor() {
    super("model call pending");
  }
}

/** Thrown by `barrier()`: the stage needs these answers before it can go on. */
export class NeedModel extends Error {
  readonly calls: ModelCall[];
  constructor(calls: ModelCall[]) {
    super("model answers needed");
    this.calls = calls;
  }
}

export type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

/**
 * Awaits a port call without letting its rejection escape: a pending call
 * rejects with PendingCall, which stage code must not mistake for a failure.
 * Call `port.barrier()` right after, then look at `ok`.
 */
export function settle<T>(p: Promise<T>): Promise<Settled<T>> {
  return p.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }),
  );
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const parts = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
  return `{${parts.join(",")}}`;
}

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

/** "c_" + FNV-1a 64 (16 hex chars) of the canonical JSON of the call minus its id. Synchronous. */
export function callId(call: Omit<ModelCall, "id">): string {
  let hash = FNV_OFFSET;
  for (const byte of new TextEncoder().encode(canonicalJson(call))) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & MASK_64;
  }
  return `c_${hash.toString(16).padStart(16, "0")}`;
}

export class StepPort {
  private pending: ModelCall[] = [];
  private readonly used = new Set<string>();

  constructor(
    private readonly answers: Answers,
    private readonly cfg: RuntimeConfig,
  ) {}

  private async ask(call: Omit<ModelCall, "id">): Promise<ModelAnswer> {
    const id = callId(call);
    const answer = Object.prototype.hasOwnProperty.call(this.answers, id) ? this.answers[id] : undefined;
    if (answer === undefined) {
      if (!this.pending.some((p) => p.id === id)) this.pending.push({ id, ...call });
      throw new PendingCall();
    }
    this.used.add(id);
    if ("error" in answer) throw new AppError("UNCLEAR_RETRY");
    return answer;
  }

  private build(
    purpose: Purpose,
    system: string,
    messages: StepMessage[],
    output: ModelCall["output"],
    extra?: StepCallExtra,
  ): Omit<ModelCall, "id"> {
    const o = geminiCallOpts(this.cfg, purpose);
    return {
      purpose,
      model: o.model,
      system,
      messages: messages.map((m) => ({ role: m.role === "user" ? "user" : "model", text: m.text })),
      output,
      max_output_tokens: o.max_output_tokens,
      temperature: o.temperature,
      thinking_budget: o.thinking_budget,
      timeout_ms: o.timeout_ms,
      required: extra?.required ?? false,
      ...(extra?.attempt !== undefined ? { attempt: extra.attempt } : {}),
    };
  }

  async text(purpose: Purpose, system: string, messages: StepMessage[], extra?: StepCallExtra): Promise<string> {
    const answer = await this.ask(this.build(purpose, system, messages, { kind: "text" }, extra));
    if (!("text" in answer) || typeof answer.text !== "string") throw new AppError("UNCLEAR_RETRY");
    return answer.text;
  }

  async json(
    purpose: Purpose,
    system: string,
    userContent: string,
    jsonSchema: Record<string, unknown>,
    extra?: StepCallExtra,
  ): Promise<unknown> {
    const schema = toGeminiSchema(jsonSchema);
    const answer = await this.ask(
      this.build(purpose, system, [{ role: "user", text: userContent }], { kind: "json", schema }, extra),
    );
    if (!("json" in answer)) throw new AppError("UNCLEAR_RETRY");
    return answer.json;
  }

  /** `Provider` for the reused `condense()` / `callRepairProvider()`. `streamChat` is never used on this relay. */
  asProvider(purpose: Purpose, extra?: StepCallExtra): Provider {
    return {
      streamChat: () => {
        throw new Error("streamChat is not available on the step relay");
      },
      structuredCompletion: async (params: StructuredCompletionParams): Promise<StructuredCompletionResult> => {
        const usage = { inputTokens: 0, outputTokens: 0 };
        if (params.jsonSchema) {
          const json = await this.json(purpose, params.systemPrompt, params.userContent, params.jsonSchema.schema, extra);
          return { text: JSON.stringify(json), json, usage };
        }
        const text = await this.text(purpose, params.systemPrompt, [{ role: "user", text: params.userContent }], extra);
        return { text, usage };
      },
    };
  }

  /** The `(system, user, schema) => …` shape of `runFinishCheck` / `verifySettled` / `gatherEvidence`. */
  asStructuredCall(purpose: Purpose, extra?: StepCallExtra) {
    const provider = this.asProvider(purpose, extra);
    const model = this.cfg.gemini.models[purpose];
    return async (
      systemPrompt: string,
      userContent: string,
      jsonSchema: { name: string; schema: Record<string, unknown> },
    ): Promise<{ result: StructuredCompletionResult; providerId: string; model: string }> => {
      const result = await provider.structuredCompletion({
        baseUrl: "",
        apiKey: "",
        model,
        systemPrompt,
        userContent,
        maxTokens: 0,
        temperature: 0,
        jsonSchema,
      });
      return { result, providerId: "gemini", model };
    };
  }

  /** Throws `NeedModel` with every call recorded since the last barrier; no-op when nothing is pending. */
  barrier(): void {
    if (this.pending.length === 0) return;
    const calls = this.pending;
    this.pending = [];
    throw new NeedModel(calls);
  }

  /** Answer ids no call asked for. Non-empty at `done` means the state moved between steps. */
  unused(): string[] {
    return Object.keys(this.answers).filter((id) => !this.used.has(id));
  }
}
