import { describe, expect, it } from "vitest";
import { getPrivate, getPublicManifest } from "../../src/lib/content";
import type { ModelCall } from "../../src/lib/step-port";
import { deviceDay, evidenceAnswer, mintInstallId, postStep, quotedHits, runSteps, type StepScript } from "./helpers";

// POST /v2/judge — the step protocol (contracts/relay-steps.md).

const problem = { public: getPublicManifest().problems.find((p) => p.id === "vp-0001")!, private: getPrivate("vp-0001")! };
const requiredKeys = problem.private.key_insights.filter((i) => i.required).map((i) => i.key);
const allKeys = problem.private.key_insights.map((i) => i.key);

const CONVERSATION = [
  { role: "user", text: "I think a hash map storing seen numbers would work." },
  { role: "tutor", text: "What do you look up at each step?" },
  { role: "user", text: "The complement, so I can check it in one pass." },
];

function assessment(over: Record<string, unknown> = {}) {
  return {
    approach_quote: "I think a hash map storing seen numbers would work",
    matched_approach: "hashmap",
    matched_verdict: "optimal",
    insights_hit: quotedHits(requiredKeys, "The complement, so I can check it in one pass"),
    insights_missed: allKeys.filter((k) => !requiredKeys.includes(k)),
    wrong_turns_taken: [],
    complexity: {
      user_claimed_time: "O(n)",
      user_claimed_space: "O(n)",
      reference_time: "O(n)",
      reference_space: "O(n)",
      assessment: "correct",
    },
    verdict: "pass",
    confidence: 0.92,
    feedback: "You landed on the hash map approach, which handles this well.",
    ...over,
  };
}

/** A good approach recognised with not one insight: the model contradicts itself. */
const CONTRADICTORY = assessment({ insights_hit: [], insights_missed: allKeys });

/** judge → `judgeAnswers` in order (the last repeats); progress fails; evidence supports everything. */
function script(judgeAnswers: unknown[] = [assessment()], progress?: unknown): StepScript {
  let n = 0;
  return (call: ModelCall) => {
    if (call.purpose === "judge") return { json: judgeAnswers[Math.min(n++, judgeAnswers.length - 1)] };
    if (call.purpose === "progress") return progress === undefined ? undefined : { json: progress };
    if (call.purpose === "evidence") return evidenceAnswer(call);
    return undefined;
  };
}

const payload = (extra: Record<string, unknown> = {}) => ({
  request: { problem_id: "vp-0001", conversation: CONVERSATION, ended_by: "user", ...extra },
});

const judge = (installId: string, s: StepScript, extra: Record<string, unknown> = {}) =>
  runSteps("/v2/judge", installId, payload(extra), s);

describe("POST /v2/judge — the loop", () => {
  it("asks progress, then the judge, then the evidence check, and returns the v1 assessment", async () => {
    const run = await judge(await mintInstallId(), script());
    expect(run.status).toBe(200);
    expect(run.rounds.map((r) => r.map((c) => c.purpose))).toEqual([["progress"], ["judge"], ["evidence"]]);
    expect(run.rounds[1][0]).toMatchObject({ required: true, output: { kind: "json" } });
    expect(run.body.status).toBe("done");
    const a = run.body.assessment;
    expect([...new Set([...a.insights_hit, ...a.insights_missed])].sort()).toEqual([...allKeys].sort());
    expect(a.insights_hit.filter((k: string) => a.insights_missed.includes(k))).toEqual([]);
    expect(a.editorial).toBe(problem.private.editorial);
    expect(a.verdict).toBe("pass");
  });

  it("the judge call's schema carries only this problem's authored enums, in the Gemini subset", async () => {
    const run = await judge(await mintInstallId(), script());
    const schema = (run.rounds[1][0].output as { kind: "json"; schema: any }).schema;
    expect(JSON.stringify(schema)).not.toContain("additionalProperties");
    expect(schema.properties.matched_approach.enum).toEqual([...problem.private.reference_approaches.map((a) => a.key), "none"]);
  });

  it("the conversation goes in the user message and the ground truth in the system prompt", async () => {
    const run = await judge(await mintInstallId(), script());
    const call = run.rounds[1][0];
    expect(call.messages[0].text).toContain("user: The complement, so I can check it in one pass.");
    expect(call.system).not.toContain("The complement, so I can check it in one pass");
  });

  it("a usable progress check adds the support check and a Settled insights block", async () => {
    const progress = { insights: [{ key: "complement_lookup", learner_quote: "The complement, so I can check it in one pass", tutor_quote: "" }], named: [] };
    const run = await judge(await mintInstallId(), script([assessment()], progress));
    expect(run.rounds.map((r) => r.map((c) => c.purpose))).toEqual([["progress"], ["evidence"], ["judge"], ["evidence"]]);
    expect(run.rounds[2][0].messages[0].text).toContain("Settled insights:");
    expect(run.body.assessment.insights_hit).toContain("complement_lookup");
  });

  it("a self-contradictory first answer is asked again once, with a distinct call id", async () => {
    const run = await judge(await mintInstallId(), script([CONTRADICTORY, assessment()]));
    const judgeRounds = run.rounds.filter((r) => r.some((c) => c.purpose === "judge"));
    expect(judgeRounds).toHaveLength(2);
    expect(judgeRounds[1][0].attempt).toBe(2);
    expect(judgeRounds[1][0].id).not.toBe(judgeRounds[0][0].id);
    expect(judgeRounds[1][0].required).toBe(false);
  });

  it("a consistent first answer is never asked twice", async () => {
    const run = await judge(await mintInstallId(), script());
    expect(run.rounds.flat().filter((c) => c.purpose === "judge")).toHaveLength(1);
  });

  it("a failed second ask keeps the first answer", async () => {
    let judges = 0;
    const run = await judge(await mintInstallId(), (call) => {
      if (call.purpose === "judge") return ++judges === 1 ? { json: CONTRADICTORY } : undefined;
      return call.purpose === "evidence" ? evidenceAnswer(call) : undefined;
    });
    expect(run.status).toBe(200);
    expect(run.body.assessment.verdict).not.toBe("pass"); // mapVerdict overwrote the contradiction
  });

  it("an unreadable judge answer is UNCLEAR_RETRY and the session stays unjudged", async () => {
    const installId = await mintInstallId();
    const run = await judge(installId, script([{ nonsense: true }]));
    expect(run.status).toBe(502);
    expect(run.body.error).toMatchObject({ code: "UNCLEAR_RETRY", retryable: true });
    expect((await deviceDay(installId))?.judged_at ?? null).toBeNull();
  });
});

describe("POST /v2/judge — one assessment per session", () => {
  it("claims the session only at done: an abandoned loop leaves it unjudged", async () => {
    const installId = await mintInstallId();
    const first = await postStep("/v2/judge", installId, { ...payload(), answers: {} });
    expect(first.body.status).toBe("model");
    expect(await deviceDay(installId)).toBeNull();
  });

  it("a failure is retryable in fact: the retry judges", async () => {
    const installId = await mintInstallId();
    expect((await judge(installId, script([{ nonsense: true }]))).status).toBe(502);
    const retry = await judge(installId, script());
    expect(retry.status).toBe(200);
    expect((await deviceDay(installId))!.judged_at).not.toBeNull();
  });

  it("a second judge of the same session is SESSION_ALREADY_JUDGED before any call", async () => {
    const installId = await mintInstallId();
    expect((await judge(installId, script())).status).toBe(200);
    const again = await postStep("/v2/judge", installId, { ...payload(), answers: {} });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("SESSION_ALREADY_JUDGED");
  });
});

describe("POST /v2/judge — guards and solution-ended sessions", () => {
  it("rejects a bad body and an unknown problem as BAD_REQUEST", async () => {
    const installId = await mintInstallId();
    expect((await postStep("/v2/judge", installId, { request: { problem_id: "vp-0001" } })).status).toBe(400);
    expect((await postStep("/v2/judge", installId, payload({ problem_id: "vp-9999" }))).status).toBe(400);
    expect((await postStep("/v2/judge", null, payload())).status).toBe(400);
  });

  it("ended_by: solution without reveal_at_index is BAD_REQUEST", async () => {
    expect((await postStep("/v2/judge", await mintInstallId(), payload({ ended_by: "solution" }))).status).toBe(400);
  });

  it("a solution-ended session is graded on the conversation before the reveal", async () => {
    const conversation = [
      ...CONVERSATION,
      { role: "tutor", text: "REVEALED_SOLUTION_TEXT" },
      { role: "user", text: "ok thanks" },
    ];
    const run = await runSteps(
      "/v2/judge",
      await mintInstallId(),
      { request: { problem_id: "vp-0001", conversation, ended_by: "solution", reveal_at_index: 3 } },
      script(),
    );
    expect(run.status).toBe(200);
    expect(JSON.stringify(run.rounds)).not.toContain("REVEALED_SOLUTION_TEXT");
  });

  it("an answer no call asked for is STEP_DIVERGED and nothing is claimed", async () => {
    const installId = await mintInstallId();
    const run = await runSteps("/v2/judge", installId, payload(), script(), 6, { c_0123456789abcdef: { text: "stale" } });
    expect(run.status).toBe(409);
    expect(run.body.error.code).toBe("STEP_DIVERGED");
    expect(await deviceDay(installId)).toBeNull();
  });
});
