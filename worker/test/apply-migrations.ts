// Runs once per test file inside the Workers runtime, before any test.
// Applies worker/migrations/*.sql (including the config seed row) to
// the isolated-storage D1 instance so every unit and contract test starts
// from the same schema `wrangler d1 migrations apply --local` would produce.
import { applyD1Migrations, env } from "cloudflare:test";
import { TEST_GEMINI_CONFIG } from "./fixtures/gemini-config";
import type { D1Migration } from "@cloudflare/vitest-pool-workers/config";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
    TEST_MIGRATIONS: D1Migration[];
    EXPECTED_PROMPTS: { tutor: string; judge: string; condense: string; repair: string; finishCheck: string; evidenceCheck: string };
    /** worker/src/**\/*.ts, path -> content, injected at config-build time (T095). */
    WORKER_SOURCE: Record<string, string>;
    INSTALL_HMAC_SECRET: string;
    TRIAL_KEY_GROQ: string;
    STT_KEY_GROQ: string;
    TRIAL_KEY_TEST2?: string;
    /** harness project only — a real Gemini key, injected from process.env.GEMINI_API_KEY at config-build time. */
    GEMINI_API_KEY?: string;
    /** harness project only — model ids under test (defaults in gemini-app-client.ts). */
    GEMINI_MODEL_FLASH?: string;
    GEMINI_MODEL_LITE?: string;
    INSTALL_RL: RateLimit;
    // Feature 007, web-only routes.
    WEB_EVENT_RL: RateLimit;
    TURNSTILE_SECRET: string;
  }
}

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// The Firebase relay requires a `gemini` config block that production seeds by
// hand (worker/README.md). Tests get a fixed one so every config parses.
{
  const row = await env.DB.prepare("SELECT payload FROM config WHERE id = 1").first<{ payload: string }>();
  const cfg = JSON.parse(row!.payload);
  cfg.gemini = TEST_GEMINI_CONFIG;
  await env.DB.prepare("UPDATE config SET payload = ? WHERE id = 1").bind(JSON.stringify(cfg)).run();
}

// Every contract test mints installs from the same (absent) client IP, so the
// real per-IP limiter would trip across unrelated cases. install.test.ts
// overrides this to exercise the 429.
env.INSTALL_RL.limit = async () => ({ success: true });
