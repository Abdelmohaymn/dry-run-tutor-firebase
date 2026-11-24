import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { mintInstallId } from "./helpers";

// The step relay holds no model key and calls no model (feature 010): the v1
// model routes are gone, not merely unused.
describe("the v1 model routes are unmounted", () => {
  for (const path of ["/v1/chat", "/v1/judge", "/v1/trial", "/v1/repair"]) {
    it(`${path} is 404`, async () => {
      const res = await SELF.fetch(`https://worker.test${path}`, {
        method: "POST",
        headers: { "X-Install-Id": await mintInstallId(), "content-type": "application/json" },
        body: "{}",
      });
      expect(res.status).toBe(404);
    });
  }
});
