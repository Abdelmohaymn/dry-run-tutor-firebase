import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { mintInstallId, postStep, turnPayload } from "./helpers";

// US6 scenario 2.
describe("killed_problem_ids lever", () => {
  it("a problem_id added to killed_problem_ids is served as unavailable and /v2/turn returns PROBLEM_KILLED for it", async () => {
    const row = await env.DB.prepare("SELECT payload FROM config WHERE id = 1").first<{
      payload: string;
    }>();
    const cfg = JSON.parse(row!.payload);
    cfg.killed_problem_ids = ["vp-0001"];
    await env.DB.prepare("UPDATE config SET payload = ? WHERE id = 1").bind(JSON.stringify(cfg)).run();

    const served = (await (await SELF.fetch("https://worker.test/v1/config")).json()) as any;
    expect(served.killed_problem_ids).toContain("vp-0001");

    const res = await postStep("/v2/turn", await mintInstallId(), turnPayload("hello there, friend"));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("PROBLEM_KILLED");
  });
});
