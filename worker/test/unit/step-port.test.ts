import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { AppError } from "../../src/lib/errors";
import { getRuntimeConfig } from "../../src/lib/runtime-config";
import { callId, NeedModel, PendingCall, StepPort, type ModelCall } from "../../src/lib/step-port";

const SCHEMA = { type: "object", additionalProperties: false, required: ["a"], properties: { a: { type: "string" } } };

async function port(answers = {}) {
  return new StepPort(answers, await getRuntimeConfig(env.DB));
}

async function pendingOf(p: StepPort, run: () => Promise<unknown>): Promise<ModelCall[]> {
  await expect(run()).rejects.toBeInstanceOf(PendingCall);
  try {
    p.barrier();
  } catch (e) {
    return (e as NeedModel).calls;
  }
  throw new Error("barrier did not throw");
}

describe("callId()", () => {
  const base = {
    purpose: "tutor" as const,
    model: "m",
    system: "s",
    messages: [{ role: "user" as const, text: "hi" }],
    output: { kind: "text" as const },
    max_output_tokens: 10,
    temperature: 0,
    thinking_budget: 0,
    timeout_ms: 1000,
    required: true,
  };

  it("is c_ + 16 hex chars and independent of key order", () => {
    const id = callId(base);
    expect(id).toMatch(/^c_[0-9a-f]{16}$/);
    expect(callId({ ...base, messages: [{ text: "hi", role: "user" }] })).toBe(id);
  });

  it("changes with attempt and with any field", () => {
    expect(callId({ ...base, attempt: 2 })).not.toBe(callId(base));
    expect(callId({ ...base, system: "t" })).not.toBe(callId(base));
  });
});

describe("StepPort", () => {
  it("same inputs give the same call id; a different attempt gives a different one", async () => {
    const p1 = await port();
    const c1 = await pendingOf(p1, () => p1.text("tutor", "sys", [{ role: "user", text: "x" }]));
    const p2 = await port();
    const c2 = await pendingOf(p2, () => p2.text("tutor", "sys", [{ role: "user", text: "x" }]));
    const p3 = await port();
    const c3 = await pendingOf(p3, () => p3.json("judge", "sys", "x", SCHEMA, { attempt: 2 }));
    const p4 = await port();
    const c4 = await pendingOf(p4, () => p4.json("judge", "sys", "x", SCHEMA));
    expect(c1[0]!.id).toBe(c2[0]!.id);
    expect(c3[0]!.id).not.toBe(c4[0]!.id);
  });

  it("collects every unanswered call of a stage, then barrier() throws NeedModel once", async () => {
    const p = await port();
    const r = await Promise.allSettled([
      p.text("tutor", "sys", [{ role: "user", text: "x" }], { required: true }),
      p.json("progress", "sys", "y", SCHEMA),
    ]);
    expect(r.every((x) => x.status === "rejected")).toBe(true);
    let calls: ModelCall[] = [];
    try {
      p.barrier();
    } catch (e) {
      calls = (e as NeedModel).calls;
    }
    expect(calls.map((c) => c.purpose).sort()).toEqual(["progress", "tutor"]);
    expect(calls.find((c) => c.purpose === "tutor")!.required).toBe(true);
    expect(calls.find((c) => c.purpose === "progress")!.required).toBe(false);
    expect(calls.find((c) => c.purpose === "progress")!.output.kind).toBe("json");
    expect(() => p.barrier()).not.toThrow();
  });

  it("returns answered text and json, maps tutor role to model, and tracks unused ids", async () => {
    const probe = await port();
    const [t] = await pendingOf(probe, () => probe.text("tutor", "sys", [{ role: "tutor", text: "hello" }]));
    expect(t!.messages[0]!.role).toBe("model");
    const probe2 = await port();
    const [j] = await pendingOf(probe2, () => probe2.json("judge", "sys", "x", SCHEMA));

    const p = await port({ [t!.id]: { text: "reply" }, [j!.id]: { json: { a: "b" } }, c_stale: { text: "?" } });
    expect(await p.text("tutor", "sys", [{ role: "tutor", text: "hello" }])).toBe("reply");
    expect(await p.json("judge", "sys", "x", SCHEMA)).toEqual({ a: "b" });
    expect(() => p.barrier()).not.toThrow();
    expect(p.unused()).toEqual(["c_stale"]);
  });

  it("an error answer throws AppError UNCLEAR_RETRY", async () => {
    const probe = await port();
    const [t] = await pendingOf(probe, () => probe.text("rewrite", "s", [{ role: "user", text: "x" }]));
    const p = await port({ [t!.id]: { error: "timeout" } });
    await expect(p.text("rewrite", "s", [{ role: "user", text: "x" }])).rejects.toBeInstanceOf(AppError);
  });

  it("asProvider routes by jsonSchema; asStructuredCall returns the helper shape", async () => {
    const probe = await port();
    const calls: ModelCall[] = [];
    const prov = probe.asProvider("condense");
    await Promise.allSettled([
      prov.structuredCompletion({ baseUrl: "", apiKey: "", model: "", systemPrompt: "s", userContent: "u", maxTokens: 1, temperature: 0 }),
      prov.structuredCompletion({
        baseUrl: "", apiKey: "", model: "", systemPrompt: "s", userContent: "u", maxTokens: 1, temperature: 0,
        jsonSchema: { name: "n", schema: SCHEMA },
      }),
    ]);
    try {
      probe.barrier();
    } catch (e) {
      calls.push(...(e as NeedModel).calls);
    }
    expect(calls.map((c) => c.output.kind).sort()).toEqual(["json", "text"]);

    const answers = Object.fromEntries(calls.map((c) => [c.id, c.output.kind === "json" ? { json: { a: "z" } } : { text: "sum" }]));
    const p = await port(answers);
    const structured = await p.asStructuredCall("condense")("s", "u", { name: "n", schema: SCHEMA });
    expect(structured.result.json).toEqual({ a: "z" });
    expect(structured.model).toBe("test-model");
    const text = await p.asProvider("condense").structuredCompletion({
      baseUrl: "", apiKey: "", model: "", systemPrompt: "s", userContent: "u", maxTokens: 1, temperature: 0,
    });
    expect(text.text).toBe("sum");
    expect(() => p.asProvider("repair").streamChat({} as never)).toThrow();
  });
});
