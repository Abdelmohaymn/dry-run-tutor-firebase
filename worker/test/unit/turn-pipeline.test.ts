import { env } from "cloudflare:test";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { runConversationalTurn } from "../../src/lib/chat-core";
import { getPrivate, getPublicManifest } from "../../src/lib/content";
import { getRuntimeConfig } from "../../src/lib/runtime-config";
import { NeedModel, StepPort, type ModelCall } from "../../src/lib/step-port";
import { runTurnSteps, type TurnStepInput } from "../../src/lib/turn-pipeline";
import { releaseSolution } from "../../src/lib/turn-cap";
import type { ProviderMessage } from "../../src/lib/provider";
import type { ChatRequest } from "../../src/lib/schemas";
import type { Problem } from "../../../tools/problem-types";

const problem: Problem = {
  public: getPublicManifest().problems.find((p) => p.id === "vp-0001")!,
  private: getPrivate("vp-0001")!,
};

/** What the v1 path sends to its model for [body] on a fresh install (turn 1). */
async function v1Prompt(body: ChatRequest, solutionRequests: number) {
  const cfg = await getRuntimeConfig(env.DB);
  let seen: { system: string; messages: ProviderMessage[] } | undefined;
  const app = new Hono();
  app.post("/", (c) =>
    runConversationalTurn(
      c,
      body,
      {
        db: env.DB,
        installId: `unit${crypto.randomUUID().replace(/-/g, "")}`,
        problemId: "vp-0001",
        date: "2026-11-24",
        cfg,
        provider: { streamChat: () => { throw new Error("unused"); }, structuredCompletion: () => { throw new Error("unused"); } },
        turnCap: cfg.chat.turn_cap,
        groundTruthTier: "AB",
        condenseEnabled: false,
        streamChat: async (system, messages) => {
          seen ??= { system, messages };
          return {
            stream: {
              deltas: (async function* () {
                yield "ok";
              })(),
              usage: async () => ({ inputTokens: 0, outputTokens: 0 }),
            },
            providerId: "test",
            model: "test",
          };
        },
        condenseCallOptions: () => ({ baseUrl: "", apiKey: "", model: "" }),
      },
      problem,
    ),
  );
  const res = await app.request("/", { method: "POST" }, env);
  await res.text();
  return seen!;
}

/** The first tutor call the v2 pipeline asks for, same inputs. */
async function v2TutorCall(body: ChatRequest, solutionRequests: number, offlineNote?: string): Promise<ModelCall[]> {
  const cfg = await getRuntimeConfig(env.DB);
  cfg.finish_offer.enabled = false;
  const planned = { turnIndex: 1, solutionRequests };
  const released = releaseSolution(planned.turnIndex, planned.solutionRequests);
  const input: TurnStepInput = {
    body,
    problem,
    cfg,
    counters: { reachedKeys: [], assistedKeys: [], namedTerms: [] },
    planned,
    released,
    sessionEnded: null,
    turnsRemaining: cfg.chat.turn_cap - 1,
    offlineNote,
  };
  try {
    await runTurnSteps(input, new StepPort({}, cfg));
  } catch (err) {
    if (err instanceof NeedModel) return err.calls;
    throw err;
  }
  throw new Error("expected the pipeline to ask for a call");
}

const body = (extra: Partial<ChatRequest> = {}): ChatRequest => ({
  problem_id: "vp-0001",
  messages: [
    { role: "user", text: "I would check every pair with two loops" },
    { role: "tutor", text: "What does that cost on a long list?" },
    { role: "user", text: "Quadratic, so I want to do better than that" },
  ],
  hint_requested: false,
  solution_request_count: 0,
  finish_offer_dismissed: false,
  ...extra,
});

describe("turn pipeline vs the v1 path", () => {
  it("builds the tutor system prompt and messages byte for byte", async () => {
    const v1 = await v1Prompt(body(), 0);
    const [call] = await v2TutorCall(body(), 0);
    expect(call.purpose).toBe("tutor");
    expect(call.system).toBe(v1.system);
    expect(call.messages).toEqual(v1.messages.map((m) => ({ role: m.role === "user" ? "user" : "model", text: m.text })));
  });

  it("matches after a first solution request too (the count reaches the prompt)", async () => {
    // A fresh row clamps the claimed count to one step, so v1 plans 1 here as well.
    const b = body({ solution_request_count: 1 });
    const v1 = await v1Prompt(b, 1);
    const [call] = await v2TutorCall(b, 1);
    expect(call.system).toBe(v1.system);
    expect(call.system).toContain("1 times so far");
  });

  it("puts the offline note right after the summary line and before the replayed turns", async () => {
    const [call] = await v2TutorCall(body({ summary: "EARLIER_SUMMARY" }), 0, "NOTE_Q");
    const texts = call.messages.map((m) => m.text);
    expect(texts[0]).toBe("[Context from earlier in this conversation: EARLIER_SUMMARY]");
    expect(texts[1]).toBe("[While offline, the learner said: NOTE_Q]");
    expect(texts[2]).toContain("I would check every pair");
  });

  it("leaves messages untouched when there is no offline note", async () => {
    const [withNote] = await v2TutorCall(body(), 0, "NOTE_Q");
    const [without] = await v2TutorCall(body(), 0);
    expect(without.messages.length).toBe(withNote.messages.length - 1);
    expect(JSON.stringify(without)).not.toContain("offline");
  });
});
