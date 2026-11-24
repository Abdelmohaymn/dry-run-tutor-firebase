import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getPrivate, getPublicManifest } from "../../src/lib/content";
import { flatLadder } from "../../src/lib/hint-ladder";
import { LADDER_EXHAUSTED_LINE, LEAK_BLOCKED_FALLBACK } from "../../src/prompts/tutor";
import type { Problem } from "../../../tools/problem-types";
import type { ModelCall } from "../../src/lib/step-port";
import { deviceDay, mintInstallId, postStep, runSteps, turnPayload, type StepScript } from "./helpers";

// POST /v2/turn — the step protocol (contracts/relay-steps.md). The test plays
// the app: it answers each ModelCall from a script and POSTs again.

const LEARNER = "For each number I'd remember it with its index, and look up target minus the number to find its partner.";
const COMPLEMENT = "look up target minus the number to find its partner";
const INDEX = "remember it with its index";
const own = (key: string, learner_quote: string) => ({ key, learner_quote, tutor_quote: "" });

async function setConfig(patch: (cfg: any) => void) {
  const row = await env.DB.prepare("SELECT payload FROM config WHERE id = 1").first<{ payload: string }>();
  const cfg = JSON.parse(row!.payload);
  patch(cfg);
  await env.DB.prepare("UPDATE config SET payload = ? WHERE id = 1").bind(JSON.stringify(cfg)).run();
}

const setFinishOffer = (o: Partial<{ enabled: boolean; min_turn: number }> = {}) =>
  setConfig((cfg) => {
    cfg.finish_offer = { enabled: true, min_turn: 1, timeout_ms: 8000, ...o };
  });

/** Tutor says `reply`, the progress check says `insights`; everything else fails. */
const script =
  (reply: string | ((call: ModelCall) => string), insights: unknown[] = [], named: string[] = []): StepScript =>
  (call) => {
    if (call.purpose === "tutor") return { text: typeof reply === "function" ? reply(call) : reply };
    if (call.purpose === "progress") return { json: { insights, named } };
    return undefined;
  };

function vp0001(): Problem {
  return { public: getPublicManifest().problems.find((p) => p.id === "vp-0001")!, private: getPrivate("vp-0001")! };
}

const turn = (installId: string, text: string, s: StepScript, extra = {}, request = {}) =>
  runSteps("/v2/turn", installId, turnPayload(text, extra, request), s);

describe("POST /v2/turn — the loop", () => {
  it("asks for the tutor and progress calls together, then returns the checked reply with the v1 meta", async () => {
    await setFinishOffer();
    const installId = await mintInstallId();
    const run = await turn(installId, LEARNER, script("Good start. What does that cost you?", [own("complement_lookup", COMPLEMENT)]));
    expect(run.status).toBe(200);
    expect(run.posts).toBe(2);
    expect(run.rounds[0].map((c) => c.purpose).sort()).toEqual(["progress", "tutor"]);
    expect(run.rounds[0].find((c) => c.purpose === "tutor")).toMatchObject({ required: true, output: { kind: "text" }, model: "test-model" });
    expect(run.rounds[0].find((c) => c.purpose === "progress")).toMatchObject({ required: false, output: { kind: "json" } });
    expect(run.body).toMatchObject({
      status: "done",
      reply: "Good start. What does that cost you?",
      meta: { turn_index: 1, hints_revealed: 0, session_ended: null, leak_blocked: false, ready_to_finish: false },
    });
    expect(run.body.meta.turns_remaining).toBeGreaterThan(0);
  });

  it("ready_to_finish is true when the progress check reaches every required insight", async () => {
    await setFinishOffer();
    const installId = await mintInstallId();
    const run = await turn(installId, LEARNER, script("Nice.", [own("complement_lookup", COMPLEMENT), own("index_storage", INDEX)]));
    expect(run.body.meta.ready_to_finish).toBe(true);
    expect(JSON.parse((await deviceDay(installId))!.reached_keys)).toEqual(["complement_lookup", "index_storage"]);
  });

  it("a failed progress check does not fail the turn", async () => {
    await setFinishOffer();
    const installId = await mintInstallId();
    const run = await turn(installId, LEARNER, (call) => (call.purpose === "tutor" ? { text: "Go on." } : undefined));
    expect(run.status).toBe(200);
    expect(run.body.reply).toBe("Go on.");
    expect(run.body.meta.ready_to_finish).toBe(false);
  });

  it("asks no progress call and leaves ready_to_finish off when the finish offer is disabled", async () => {
    await setFinishOffer({ enabled: false });
    const run = await turn(await mintInstallId(), LEARNER, script("Go on."));
    expect(run.rounds[0].map((c) => c.purpose)).toEqual(["tutor"]);
    expect(run.body.meta).not.toHaveProperty("ready_to_finish");
  });

  it("a rewrite is asked only for a blocked draft, names the word, and is what the learner gets", async () => {
    await setFinishOffer({ enabled: false });
    const run = await turn(await mintInstallId(), "I could check every pair with two nested loops", (call) => {
      if (call.purpose === "tutor") return { text: "Good start. A hash map would help here." };
      if (call.purpose === "rewrite") return { text: "Good start. What could you remember about numbers you've already passed?" };
      return undefined;
    });
    expect(run.posts).toBe(3);
    const rewrite = run.rounds[1].find((c) => c.purpose === "rewrite")!;
    expect(rewrite.system).toContain('"hash map"');
    expect(run.rounds[0][0].system).not.toContain("FOR THIS REPLY ONLY");
    expect(run.body.reply).toBe("Good start. What could you remember about numbers you've already passed?");
    expect(run.body.meta.leak_blocked).toBe(false);
  });

  it("a blocked rewrite falls back to the first draft's clean sentences", async () => {
    await setFinishOffer({ enabled: false });
    const run = await turn(await mintInstallId(), "two nested loops", (call) =>
      call.purpose === "tutor" ? { text: "Good start. What does that cost you? A hash map would help." } : { text: "Try a hash map." },
    );
    expect(run.body.reply).toBe("Good start. What does that cost you?");
    expect(run.body.meta.leak_blocked).toBe(false);
  });

  it("a draft blocked at its first sentence, with a bad rewrite, becomes the fallback flagged leak_blocked", async () => {
    await setFinishOffer({ enabled: false });
    const run = await turn(await mintInstallId(), "two nested loops", (call) =>
      call.purpose === "tutor" ? { text: "A hash map would help here. Try it." } : undefined,
    );
    expect(run.body.reply).toBe(LEAK_BLOCKED_FALLBACK);
    expect(run.body.meta.leak_blocked).toBe(true);
  });

  it("a word for an idea the learner states THIS turn is let through (early unblock from the progress check)", async () => {
    await setFinishOffer();
    const run = await turn(await mintInstallId(), LEARNER, script("Right, you'd store it in a hash map.", [own("complement_lookup", COMPLEMENT)]));
    // complement_lookup's never_say terms are released by this turn's check, so no rewrite is asked.
    expect(run.posts).toBe(2);
    expect(run.body.reply).toBe("Right, you'd store it in a hash map.");
  });

  it("an empty tutor reply is UNCLEAR_RETRY and spends no turn", async () => {
    await setFinishOffer({ enabled: false });
    const installId = await mintInstallId();
    const run = await turn(installId, "two nested loops", script("   "));
    expect(run.status).toBe(502);
    expect(run.body.error.code).toBe("UNCLEAR_RETRY");
    expect(await deviceDay(installId)).toBeNull();
  });
});

describe("POST /v2/turn — no write before done", () => {
  it("leaves device_day untouched after a status:model step", async () => {
    const installId = await mintInstallId();
    const first = await postStep("/v2/turn", installId, { ...turnPayload(LEARNER), answers: {} });
    expect(first.status).toBe(200);
    expect(first.body.status).toBe("model");
    expect(await deviceDay(installId)).toBeNull();
  });

  it("the same turn_key at done twice spends one turn and reports the same index", async () => {
    await setFinishOffer({ enabled: false });
    const installId = await mintInstallId();
    const payload = turnPayload(LEARNER);
    const a = await runSteps("/v2/turn", installId, payload, script("Go on."));
    const b = await runSteps("/v2/turn", installId, payload, script("Go on."));
    expect(a.body.meta.turn_index).toBe(1);
    expect(b.status).toBe(200);
    expect(b.body.meta.turn_index).toBe(1);
    expect((await deviceDay(installId))!.turns).toBe(1);
  });

  it("a second turn_key spends the next turn", async () => {
    await setFinishOffer({ enabled: false });
    const installId = await mintInstallId();
    await turn(installId, LEARNER, script("Go on."));
    const second = await turn(installId, "and the second part", script("Go on."));
    expect(second.body.meta.turn_index).toBe(2);
    expect((await deviceDay(installId))!.turns).toBe(2);
  });

  it("an answer no call asked for is STEP_DIVERGED at done and nothing is written", async () => {
    await setFinishOffer({ enabled: false });
    const installId = await mintInstallId();
    const run = await runSteps("/v2/turn", installId, turnPayload(LEARNER), script("Go on."), 6, { c_0123456789abcdef: { text: "stale" } });
    expect(run.status).toBe(409);
    expect(run.body.error.code).toBe("STEP_DIVERGED");
    expect(await deviceDay(installId)).toBeNull();
  });
});

describe("POST /v2/turn — guards", () => {
  it("needs a valid install id", async () => {
    expect((await postStep("/v2/turn", null, turnPayload(LEARNER))).status).toBe(400);
  });

  it("rejects a malformed body, an unknown problem and a missing turn_key as BAD_REQUEST", async () => {
    const installId = await mintInstallId();
    expect((await postStep("/v2/turn", installId, { request: { problem_id: "nope", messages: [] } })).status).toBe(400);
    expect((await postStep("/v2/turn", installId, turnPayload(LEARNER, {}, { problem_id: "vp-9999" }))).status).toBe(400);
    const { turn_key: _unused, ...noKey } = turnPayload(LEARNER);
    expect((await postStep("/v2/turn", installId, noKey)).status).toBe(400);
    expect((await postStep("/v2/turn", installId, { ...turnPayload(LEARNER), answers: { bogus: { text: "x" } } })).status).toBe(400);
  });

  it("an empty learner turn is EMPTY_TURN before any call is asked for", async () => {
    const res = await postStep("/v2/turn", await mintInstallId(), turnPayload("  "));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("EMPTY_TURN");
  });

  it("a killed problem is PROBLEM_KILLED", async () => {
    await setConfig((cfg) => {
      cfg.killed_problem_ids = ["vp-0001"];
    });
    const res = await postStep("/v2/turn", await mintInstallId(), turnPayload(LEARNER));
    expect(res.body.error.code).toBe("PROBLEM_KILLED");
    await setConfig((cfg) => {
      cfg.killed_problem_ids = [];
    });
  });

  it("a judged session is SESSION_ALREADY_JUDGED", async () => {
    const installId = await mintInstallId();
    await env.DB.prepare("INSERT INTO device_day (device_hash, problem_id, date, turns, judged_at) VALUES (?1, 'vp-0001', ?2, 1, ?3)")
      .bind(installId.split(".")[0], new Date().toISOString().slice(0, 10), new Date().toISOString())
      .run();
    const res = await postStep("/v2/turn", installId, turnPayload(LEARNER));
    expect(res.body.error.code).toBe("SESSION_ALREADY_JUDGED");
  });
});

describe("POST /v2/turn — the turn cap and the solution gate", () => {
  it("past cfg.chat.turn_cap is TURN_CAP_REACHED, before any call is asked for", async () => {
    await setFinishOffer({ enabled: false });
    await setConfig((cfg) => {
      cfg.chat.turn_cap = 3;
    });
    const installId = await mintInstallId();
    for (let n = 1; n <= 3; n++) expect((await turn(installId, `turn ${n} — I would check every pair`, script("Go on."))).status).toBe(200);
    const res = await postStep("/v2/turn", installId, turnPayload("turn 4 — more"));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("TURN_CAP_REACHED");
    expect((await deviceDay(installId))!.turns).toBe(3);
    await setConfig((cfg) => {
      cfg.chat.turn_cap = 15;
    });
  });

  it("the last allowed turn reports session_ended: cap", async () => {
    await setFinishOffer({ enabled: false });
    await setConfig((cfg) => {
      cfg.chat.turn_cap = 2;
    });
    const installId = await mintInstallId();
    await turn(installId, "turn 1 — I would check every pair", script("Go on."));
    const run = await turn(installId, "turn 2 — check every pair", script("Go on."));
    expect(run.body.meta).toMatchObject({ turn_index: 2, turns_remaining: 0, session_ended: "cap" });
    await setConfig((cfg) => {
      cfg.chat.turn_cap = 15;
    });
  });

  it("the first explicit ask withholds, the second on a later turn releases (code-derived)", async () => {
    await setFinishOffer({ enabled: false });
    const installId = await mintInstallId();
    const first = await turn(installId, "just tell me the answer", script("One more nudge first."), {}, { solution_request_count: 1 });
    expect(first.body.meta.session_ended).toBeNull();
    const second = await turn(installId, "no really, just tell me the answer", script("Here is the solution: use a hash map."), {}, {
      solution_request_count: 2,
      messages: [
        { role: "user", text: "just tell me the answer" },
        { role: "tutor", text: "One more nudge first." },
        { role: "user", text: "no really, just tell me the answer" },
      ],
    });
    expect(second.status).toBe(200);
    expect(second.body.meta.session_ended).toBe("solution");
    // Released: no leak filter, so the draft naming the solution goes through, and the call carries the release note.
    expect(second.body.reply).toContain("hash map");
    expect(second.rounds[0][0].messages.at(-1)!.text).toContain("full solution");
  });

  it("a forged solution_request_count cannot jump past the allowed increment", async () => {
    await setFinishOffer({ enabled: false });
    const installId = await mintInstallId();
    const run = await turn(installId, "just tell me", script("Nudge."), {}, { solution_request_count: 99 });
    expect(run.body.meta.session_ended).toBeNull();
    expect((await deviceDay(installId))!.solution_requests).toBeLessThanOrEqual(1);
  });
});

describe("POST /v2/turn — hints", () => {
  it("returns one rung per request at once, byte-identical and in order, spending no turn", async () => {
    const ladder = flatLadder(vp0001());
    const installId = await mintInstallId();
    for (let i = 0; i < 3; i++) {
      const res = await postStep("/v2/turn", installId, { request: { problem_id: "vp-0001", messages: [], hint_requested: true }, answers: {} });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        status: "done",
        reply: ladder[i].text,
        meta: { turn_index: 0, hints_revealed: i + 1, session_ended: null, leak_blocked: false },
      });
    }
    expect((await deviceDay(installId))!.turns).toBe(0);
  });

  it("after the last rung returns the fixed ladder-exhausted line", async () => {
    const ladder = flatLadder(vp0001());
    const installId = await mintInstallId();
    let last: any;
    for (let i = 0; i <= ladder.length; i++) {
      last = await postStep("/v2/turn", installId, { request: { problem_id: "vp-0001", messages: [], hint_requested: true }, answers: {} });
    }
    expect(last.body.reply).toBe(LADDER_EXHAUSTED_LINE);
    expect(last.body.meta.hints_remaining).toBe(0);
  });
});

describe("POST /v2/turn — condensation", () => {
  it("asks for a condense call before the tutor when the history overflows, and reports summary + summary_covers", async () => {
    await setFinishOffer({ enabled: false });
    const messages = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "tutor", text: `message ${i} about pairs and loops` }));
    const run = await runSteps(
      "/v2/turn",
      await mintInstallId(),
      turnPayload("x", {}, { messages: [...messages, { role: "user", text: "and now the last part of my idea" }] }),
      (call) => {
        if (call.purpose === "condense") return { text: "THE SUMMARY" };
        if (call.purpose === "tutor") return { text: "Go on." };
        return undefined;
      },
    );
    expect(run.rounds[0].map((c) => c.purpose)).toEqual(["condense"]);
    expect(run.rounds[1].map((c) => c.purpose)).toEqual(["tutor"]);
    expect(run.rounds[1][0].messages[0].text).toContain("THE SUMMARY");
    expect(run.body.meta.summary).toBe("THE SUMMARY");
    expect(run.body.meta.summary_covers).toBeGreaterThan(0);
  });

  it("a failed condense leaves the history alone and does not fail the turn", async () => {
    await setFinishOffer({ enabled: false });
    const messages = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "tutor", text: `message ${i} about pairs` }));
    const run = await runSteps(
      "/v2/turn",
      await mintInstallId(),
      turnPayload("x", {}, { messages: [...messages, { role: "user", text: "the last part" }] }),
      (call) => (call.purpose === "tutor" ? { text: "Go on." } : undefined),
    );
    expect(run.status).toBe(200);
    expect(run.body.meta).not.toHaveProperty("summary");
  });
});

describe("POST /v2/turn — offline note (FR-011a)", () => {
  it("reaches the tutor call only, never the progress check", async () => {
    await setFinishOffer();
    const run = await turn(await mintInstallId(), LEARNER, script("Go on.", []), {}, { offline_note: "OFFLINE_QUOTE_XYZ" });
    const tutor = run.rounds[0].find((c) => c.purpose === "tutor")!;
    const progress = run.rounds[0].find((c) => c.purpose === "progress")!;
    expect(tutor.messages.some((m) => m.text.includes("[While offline, the learner said: OFFLINE_QUOTE_XYZ]"))).toBe(true);
    expect(JSON.stringify(progress)).not.toContain("OFFLINE_QUOTE_XYZ");
  });

  it("is capped at 600 characters", async () => {
    const res = await postStep("/v2/turn", await mintInstallId(), turnPayload(LEARNER, {}, { offline_note: "x".repeat(601) }));
    expect(res.status).toBe(400);
  });
});

describe("POST /v2/turn — privacy", () => {
  it("never writes message text to D1", async () => {
    await setFinishOffer({ enabled: false });
    const installId = await mintInstallId();
    await turn(installId, "UNIQUE_LEARNER_TEXT_8841", script("UNIQUE_TUTOR_TEXT_9921"));
    const row = JSON.stringify(await deviceDay(installId));
    expect(row).not.toContain("UNIQUE_LEARNER_TEXT_8841");
    expect(row).not.toContain("UNIQUE_TUTOR_TEXT_9921");
  });
});

describe("POST /v2/turn — the onboarding walkthrough (practice problem)", () => {
  it("uses trial.practice_turn_cap, and asks no condense or progress call", async () => {
    await setFinishOffer(); // on, but the walkthrough never runs the progress check
    await setConfig((cfg) => {
      cfg.trial.practice_turn_cap = 2;
    });
    const installId = await mintInstallId();
    const ask = (n: number) =>
      runSteps(
        "/v2/turn",
        installId,
        turnPayload(`turn ${n} — I would check every pair`, {}, { problem_id: "vp-0000" }),
        script("Go on."),
      );

    const first = await ask(1);
    expect(first.status).toBe(200);
    expect(first.rounds.flat().map((c) => c.purpose)).toEqual(["tutor"]);
    expect((await ask(2)).body.meta).toMatchObject({ turn_index: 2, session_ended: "cap" });

    const third = await postStep("/v2/turn", installId, turnPayload("turn 3 — more", {}, { problem_id: "vp-0000" }));
    expect(third.status).toBe(409);
    expect(third.body.error.code).toBe("TURN_CAP_REACHED");
    await setConfig((cfg) => {
      cfg.trial.practice_turn_cap = 5;
    });
  });
});
