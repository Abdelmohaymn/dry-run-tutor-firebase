import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { evidenceAnswer, mintInstallId, postStep, runSteps, type StepScript } from "./helpers";

const CONVERSATION = [{ role: "user", text: "I would use a hash map." }];

const ASSESSMENT = {
  approach_quote: "I would use a hash map",
  matched_approach: "hashmap",
  matched_verdict: "optimal",
  insights_hit: [{ quote: "I would use a hash map", key: "complement_lookup" }],
  insights_missed: [],
  wrong_turns_taken: [],
  complexity: { user_claimed_time: null, user_claimed_space: null, reference_time: "O(n)", reference_space: "O(n)", assessment: "not_stated" },
  verdict: "unclear",
  confidence: 0.5,
  feedback: "Some feedback here.",
};

const judgeScript: StepScript = (call) => {
  if (call.purpose === "judge") return { json: ASSESSMENT };
  if (call.purpose === "evidence") return evidenceAnswer(call);
  return undefined;
};

const judgeRequest = { request: { problem_id: "vp-0001", conversation: CONVERSATION, ended_by: "user" } };
const judge = (installId: string) => runSteps("/v2/judge", installId, judgeRequest, judgeScript);

function reset(installId: string, body: unknown = { problem_id: "vp-0001" }) {
  return SELF.fetch("https://worker.test/v1/session/reset", {
    method: "POST",
    headers: { "X-Install-Id": installId, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// The app's recovery path for a verdict that was produced and lost on the
// way back: clear the claim, then judge the locally kept conversation again.
describe("POST /v1/session/reset", () => {
  it("rejects a malformed body", async () => {
    const res = await reset(await mintInstallId(), { nope: true });
    expect(res.status).toBe(400);
  });

  it("a judged session can be judged again after a recover reset", async () => {
    const installId = await mintInstallId();
    expect((await judge(installId)).status).toBe(200);

    // A repeat judge is refused before any model call is asked for.
    const refused = await postStep("/v2/judge", installId, { ...judgeRequest, answers: {} });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("SESSION_ALREADY_JUDGED");

    const res = await reset(installId, { problem_id: "vp-0001", reason: "recover" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    expect((await judge(installId)).status).toBe(200);
  });

  it("recover keeps today's turn counters; practice clears them", async () => {
    const installId = await mintInstallId();
    const deviceHash = installId.split(".")[0];
    const date = new Date().toISOString().slice(0, 10);
    await env.DB
      .prepare(
        `INSERT INTO device_day (device_hash, problem_id, date, turns, judged_at)
         VALUES (?1, 'vp-0001', ?2, 5, '2026-01-01T00:00:00Z')`,
      )
      .bind(deviceHash, date)
      .run();
    const row = () =>
      env.DB
        .prepare("SELECT turns, judged_at FROM device_day WHERE device_hash = ?1 AND problem_id = 'vp-0001'")
        .bind(deviceHash)
        .first<{ turns: number; judged_at: string | null }>();

    expect((await reset(installId, { problem_id: "vp-0001", reason: "recover" })).status).toBe(200);
    expect(await row()).toEqual({ turns: 5, judged_at: null });

    expect((await reset(installId, { problem_id: "vp-0001", reason: "practice" })).status).toBe(200);
    expect(await row()).toBeNull();
  });

  it("rejects an unknown reason", async () => {
    const res = await reset(await mintInstallId(), { problem_id: "vp-0001", reason: "replay" });
    expect(res.status).toBe(400);
  });
});
