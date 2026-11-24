import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ModelCall } from "../../src/lib/step-port";
import { mintInstallId, postStep, runSteps, setRepairConfig } from "./helpers";

// POST /v2/repair — one `repair` call, then the v1 guards.

const TRANSCRIPT = "so i would loop over the numbres and check each one against the target and then return the two indexes";
const FIXED = "so i would loop over the numbers and check each one against the target and then return the two indexes";

const payload = (transcript = TRANSCRIPT) => ({ request: { problem_id: "vp-0001", transcript } });
const repair = (installId: string, answer: (call: ModelCall) => { text: string } | undefined, transcript?: string) =>
  runSteps("/v2/repair", installId, payload(transcript), (call) => answer(call));

describe("POST /v2/repair", () => {
  it("asks for one required repair call and returns the guarded result", async () => {
    await setRepairConfig();
    const run = await repair(await mintInstallId(), () => ({ text: FIXED }));
    expect(run.rounds).toHaveLength(1);
    expect(run.rounds[0]).toHaveLength(1);
    expect(run.rounds[0][0]).toMatchObject({ purpose: "repair", required: true, output: { kind: "text" } });
    expect(run.rounds[0][0].messages[0].text).toContain(TRANSCRIPT);
    expect(run.body).toEqual({ status: "done", repaired: FIXED, changed: true });
  });

  it("a candidate that fails a guard leaves the transcript unchanged", async () => {
    await setRepairConfig();
    const run = await repair(await mintInstallId(), () => ({ text: "Completely unrelated text about something else entirely here." }));
    expect(run.body).toEqual({ status: "done", repaired: TRANSCRIPT, changed: false });
  });

  it("a candidate naming ground truth is discarded", async () => {
    await setRepairConfig();
    const run = await repair(await mintInstallId(), () => ({ text: `${FIXED} hash map` }));
    expect(run.body.changed).toBe(false);
  });

  it("a failed repair call leaves the transcript unchanged", async () => {
    await setRepairConfig();
    const run = await repair(await mintInstallId(), () => undefined);
    expect(run.body).toEqual({ status: "done", repaired: TRANSCRIPT, changed: false });
  });

  it("is a no-op, with no model call, when repair is disabled or the transcript is short", async () => {
    await setRepairConfig({ enabled: false });
    const off = await postStep("/v2/repair", await mintInstallId(), { ...payload(), answers: {} });
    expect(off.body).toEqual({ status: "done", repaired: TRANSCRIPT, changed: false });
    await setRepairConfig({ enabled: true });
    const short = await postStep("/v2/repair", await mintInstallId(), { ...payload("too short"), answers: {} });
    expect(short.body).toEqual({ status: "done", repaired: "too short", changed: false });
  });

  it("reserves no turn and writes nothing to D1", async () => {
    await setRepairConfig();
    const installId = await mintInstallId();
    await repair(installId, () => ({ text: FIXED }));
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM device_day WHERE device_hash = ?1").bind(installId.split(".")[0]).first<{ n: number }>();
    expect(row!.n).toBe(0);
  });

  it("rejects bad bodies and a missing install id as BAD_REQUEST", async () => {
    const installId = await mintInstallId();
    expect((await postStep("/v2/repair", installId, { request: { problem_id: "vp-0001" } })).status).toBe(400);
    expect((await postStep("/v2/repair", installId, { request: { problem_id: "vp-9999", transcript: TRANSCRIPT } })).status).toBe(400);
    expect((await postStep("/v2/repair", null, payload())).status).toBe(400);
  });
});
