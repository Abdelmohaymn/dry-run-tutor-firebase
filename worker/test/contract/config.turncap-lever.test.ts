import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { mintInstallId, postStep, runSteps, turnPayload } from "./helpers";

// US6 scenario 1, SC-012. Kept in its own file: it mutates the config row.
describe("GET /v1/config — chat.turn_cap lever change with no redeploy", () => {
  it("changing chat.turn_cap in D1 changes the served value and the enforced cap", async () => {
    const row = await env.DB.prepare("SELECT payload FROM config WHERE id = 1").first<{
      payload: string;
    }>();
    const cfg = JSON.parse(row!.payload);
    cfg.chat.turn_cap = 2;
    cfg.finish_offer = { enabled: false, min_turn: 1, timeout_ms: 8000 };
    await env.DB.prepare("UPDATE config SET payload = ? WHERE id = 1").bind(JSON.stringify(cfg)).run();

    const served = (await (await SELF.fetch("https://worker.test/v1/config")).json()) as any;
    expect(served.chat.turn_cap).toBe(2);

    const installId = await mintInstallId();
    for (let n = 1; n <= 2; n++) {
      const run = await runSteps("/v2/turn", installId, turnPayload(`turn ${n} — I would check every pair`), (call) =>
        call.purpose === "tutor" ? { text: `reply ${n}` } : undefined,
      );
      expect(run.status).toBe(200);
    }

    const third = await postStep("/v2/turn", installId, turnPayload("turn 3 — more"));
    expect(third.status).toBe(409);
    expect(third.body.error.code).toBe("TURN_CAP_REACHED");
  });
});
