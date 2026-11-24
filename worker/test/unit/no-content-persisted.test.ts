import { env, SELF, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { GROQ_ORIGIN, evidenceAnswer, mintInstallId, postStep, runSteps, turnPayload } from "../contract/helpers";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => {
  fetchMock.assertNoPendingInterceptors();
});

const TABLES = ["config", "devices", "device_day", "provider_day", "notify_signup"];

async function dumpAllTables(): Promise<string> {
  const dumps = await Promise.all(
    TABLES.map(async (t) => JSON.stringify((await env.DB.prepare(`SELECT * FROM ${t}`).all()).results)),
  );
  return dumps.join("\n");
}

// FR-026, SC-006 support. Sweeps every D1 table after a full session.
describe("no D1 table ever holds a learner key, a message, a summary, or a reply", () => {
  it("after a full chat + hint + judge + daily session, none of the secret markers are anywhere in D1", async () => {
    const LEARNER_TEXT = "MARKER_LEARNER_SAID_THIS_EXACT_PHRASE";
    const TUTOR_REPLY = "MARKER_TUTOR_REPLIED_WITH_THIS_EXACT_PHRASE";
    const JUDGE_FEEDBACK = "MARKER_JUDGE_FEEDBACK_EXACT_PHRASE";
    const SUMMARY = "MARKER_SUMMARY_EXACT_PHRASE";

    const installId = await mintInstallId();

    // A turn whose history overflows, so the condense call runs too.
    const history = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "tutor", text: `${LEARNER_TEXT} ${i}` }));
    const turn = await runSteps(
      "/v2/turn",
      installId,
      turnPayload(LEARNER_TEXT, {}, { messages: [...history, { role: "user", text: LEARNER_TEXT }] }),
      (call) => {
        if (call.purpose === "condense") return { text: SUMMARY };
        if (call.purpose === "tutor") return { text: TUTOR_REPLY };
        if (call.purpose === "progress") return { json: { insights: [{ key: "complement_lookup", learner_quote: LEARNER_TEXT, tutor_quote: "" }], named: [] } };
        return undefined;
      },
    );
    expect(turn.status).toBe(200);

    const hint = await postStep("/v2/turn", installId, {
      request: { problem_id: "vp-0001", messages: [{ role: "user", text: LEARNER_TEXT }], hint_requested: true },
      answers: {},
    });
    expect(hint.status).toBe(200);

    const judge = await runSteps(
      "/v2/judge",
      installId,
      { request: { problem_id: "vp-0001", conversation: [{ role: "user", text: LEARNER_TEXT }], ended_by: "user" } },
      (call) => {
        if (call.purpose === "judge") {
          return {
            json: {
              approach_quote: LEARNER_TEXT,
              matched_approach: "hashmap",
              matched_verdict: "optimal",
              insights_hit: [{ quote: LEARNER_TEXT, key: "complement_lookup" }],
              insights_missed: [],
              wrong_turns_taken: [],
              complexity: { user_claimed_time: null, user_claimed_space: null, reference_time: "O(n)", reference_space: "O(n)", assessment: "not_stated" },
              verdict: "unclear",
              confidence: 0.5,
              feedback: JUDGE_FEEDBACK,
            },
          };
        }
        return call.purpose === "evidence" ? evidenceAnswer(call) : undefined;
      },
    );
    expect(judge.status).toBe(200);

    await SELF.fetch(`https://worker.test/v1/daily?date=${new Date().toISOString().slice(0, 10)}`, {
      headers: { "X-Install-Id": installId },
    });

    const blob = await dumpAllTables();
    for (const marker of [LEARNER_TEXT, TUTOR_REPLY, JUDGE_FEEDBACK, SUMMARY]) {
      expect(blob).not.toContain(marker);
    }
  });

  it("a /v1/stt call leaves neither the transcript nor the audio in any D1 table", async () => {
    const TRANSCRIPT = "MARKER_STT_TRANSCRIPT_EXACT_PHRASE";
    const AUDIO_MARKER = "MARKER_STT_AUDIO_BYTES_EXACT_PHRASE";

    const row = await env.DB.prepare("SELECT payload FROM config WHERE id = 1").first<{ payload: string }>();
    const cfg = JSON.parse(row!.payload);
    cfg.voice = { enabled: true, seconds_per_device: 300, max_clip_seconds: 120 };
    await env.DB.prepare("UPDATE config SET payload = ? WHERE id = 1").bind(JSON.stringify(cfg)).run();

    const installId = await mintInstallId();

    fetchMock
      .get(GROQ_ORIGIN)
      .intercept({ path: "/openai/v1/audio/transcriptions", method: "POST" })
      .reply(200, JSON.stringify({ text: TRANSCRIPT, duration: 30 }), {
        headers: { "content-type": "application/json" },
      });
    const res = await SELF.fetch("https://worker.test/v1/stt?language=en", {
      method: "POST",
      headers: { "X-Install-Id": installId, "content-type": "audio/mp4" },
      body: new TextEncoder().encode(AUDIO_MARKER),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { text: string }).text).toBe(TRANSCRIPT);

    // The call did charge the device (so the devices row was written), yet
    // nothing in any table carries the content.
    const blob = await dumpAllTables();
    expect(blob).not.toContain(TRANSCRIPT);
    expect(blob).not.toContain(AUDIO_MARKER);
    expect(blob).not.toContain("MARKER_STT");
  });
});
