import { env, SELF } from "cloudflare:test";

export const GROQ_ORIGIN = "https://api.groq.com";

/** Registers the given Android ID; the same id always yields the same install id. */
export async function mintInstallIdFor(deviceId: string): Promise<string> {
  const res = await SELF.fetch("https://worker.test/v1/install", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ platform: "android", device_id: deviceId }),
  });
  const body = (await res.json()) as { install_id: string };
  return body.install_id;
}

export async function mintInstallId(): Promise<string> {
  return mintInstallIdFor(crypto.randomUUID().replace(/-/g, "").slice(0, 16));
}

/** Raw judge `insights_hit` entries, every key quoting the same learner words. */
export function quotedHits(keys: string[], quote: string) {
  return keys.map((key) => ({ quote, key }));
}

/**
 * Feature 004. The seed migration's `config` row carries no `repair`
 * block (it predates this feature), so every repair contract test that
 * needs `cfg.repair.enabled === true` writes one first — same D1-payload-edit
 * pattern as config.turncap-lever.test.ts. Values match
 * contracts/repair-endpoint.md §Merge — the D1 write.
 */
export async function setRepairConfig(
  overrides: Partial<{
    enabled: boolean;
    model: string;
    min_chars: number;
    max_input_chars: number;
    timeout_ms: number;
    max_output_ratio: number;
    min_word_overlap: number;
  }> = {},
): Promise<void> {
  const row = await env.DB.prepare("SELECT payload FROM config WHERE id = 1").first<{
    payload: string;
  }>();
  const cfg = JSON.parse(row!.payload);
  cfg.repair = {
    enabled: true,
    model: "llama-3.1-8b-instant",
    min_chars: 40,
    max_input_chars: 2000,
    timeout_ms: 1500,
    max_output_ratio: 1.5,
    min_word_overlap: 0.6,
    ...overrides,
  };
  await env.DB.prepare("UPDATE config SET payload = ? WHERE id = 1")
    .bind(JSON.stringify(cfg))
    .run();
}

/**
 * Feature 007. The seed migration's `config` row carries no `web`
 * block (it predates this feature), so every web-route contract test that
 * needs a known origin writes one first — same
 * D1-payload-edit pattern as setRepairConfig above.
 */
export async function setWebConfig(
  overrides: Partial<{
    allowed_origins: string[];
    notify_enabled: boolean;
  }> = {},
): Promise<void> {
  const row = await env.DB.prepare("SELECT payload FROM config WHERE id = 1").first<{
    payload: string;
  }>();
  const cfg = JSON.parse(row!.payload);
  cfg.web = {
    allowed_origins: ["https://site.test"],
    notify_enabled: true,
    ...overrides,
  };
  await env.DB.prepare("UPDATE config SET payload = ? WHERE id = 1")
    .bind(JSON.stringify(cfg))
    .run();
}

export const GROQ_STT_PATH = "/openai/v1/audio/transcriptions";

/** A Groq `verbose_json` transcription body: the text and its measured length. */
export function groqTranscriptionBody(text: string, duration: number) {
  return { text, duration };
}

/**
 * Feature 008. The seed migration's `config` row carries no `voice` block
 * (voice is off by default), so every stt contract test that needs voice on
 * writes one first — same D1-payload-edit pattern as setRepairConfig above.
 */
export async function setVoiceConfig(
  overrides: Partial<{
    enabled: boolean;
    seconds_per_device: number;
    max_clip_seconds: number;
    model: string;
  }> = {},
): Promise<void> {
  const row = await env.DB.prepare("SELECT payload FROM config WHERE id = 1").first<{
    payload: string;
  }>();
  const cfg = JSON.parse(row!.payload);
  cfg.voice = {
    enabled: true,
    seconds_per_device: 300,
    max_clip_seconds: 120,
    model: "whisper-large-v3-turbo",
    ...overrides,
  };
  await env.DB.prepare("UPDATE config SET payload = ? WHERE id = 1")
    .bind(JSON.stringify(cfg))
    .run();
}

/** Sends one raw-audio POST /v1/stt. Pass `installId: null` to omit the header. */
export async function postStt(
  installId: string | null,
  bytes: BodyInit,
  opts: { contentType?: string; language?: string } = {},
): Promise<Response> {
  const { contentType = "audio/mp4", language } = opts;
  const url = new URL("https://worker.test/v1/stt");
  if (language !== undefined) url.searchParams.set("language", language);
  const headers: Record<string, string> = { "content-type": contentType };
  if (installId !== null) headers["X-Install-Id"] = installId;
  return SELF.fetch(url.toString(), { method: "POST", headers, body: bytes });
}

// ---- Step protocol (contracts/relay-steps.md) --------------------------------

import type { Answers, ModelAnswer, ModelCall } from "../../src/lib/step-port";

/** Decides one call's answer. Return `undefined` to answer `{error:"other"}` (an optional call that failed). */
export type StepScript = (call: ModelCall) => ModelAnswer | undefined;

/** The fake app: answers every call of one `status: "model"` response. */
export function answerAll(calls: ModelCall[], script: StepScript): Answers {
  const answers: Answers = {};
  for (const call of calls) answers[call.id] = script(call) ?? { error: "other" };
  return answers;
}

export interface StepRun {
  status: number;
  body: any;
  /** The calls each `model` response carried, in order. */
  rounds: ModelCall[][];
  posts: number;
}

export async function postStep(path: string, installId: string | null, body: unknown): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (installId !== null) headers["X-Install-Id"] = installId;
  const res = await SELF.fetch(`https://worker.test${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

/**
 * Plays the app's loop: POST, answer the calls with `script`, POST again with
 * every answer so far, until `done` or an error (at most `maxPosts`).
 */
export async function runSteps(
  path: string,
  installId: string,
  payload: Record<string, unknown>,
  script: StepScript,
  maxPosts = 6,
  initialAnswers: Answers = {},
): Promise<StepRun> {
  const rounds: ModelCall[][] = [];
  let answers: Answers = { ...initialAnswers };
  let last = { status: 0, body: undefined as any };
  for (let posts = 1; posts <= maxPosts; posts++) {
    last = await postStep(path, installId, { ...payload, answers });
    if (last.status !== 200 || last.body.status !== "model") return { ...last, rounds, posts };
    const calls = last.body.calls as ModelCall[];
    rounds.push(calls);
    answers = { ...answers, ...answerAll(calls, script) };
  }
  return { ...last, rounds, posts: maxPosts };
}

/** `/v2/turn` payload for vp-0001 with one learner message. */
export function turnPayload(text: string, extra: Record<string, unknown> = {}, request: Record<string, unknown> = {}) {
  return {
    turn_key: crypto.randomUUID(),
    request: { problem_id: "vp-0001", messages: [{ role: "user", text }], ...request },
    ...extra,
  };
}

/** The `device_day` row of one install/problem, or null. */
export async function deviceDay(installId: string, problemId = "vp-0001") {
  return env.DB
    .prepare("SELECT * FROM device_day WHERE device_hash = ?1 AND problem_id = ?2")
    .bind(installId.split(".")[0], problemId)
    .first<Record<string, any>>();
}

/** An evidence-check answer that marks every claim in the call's schema as `supported`. */
export function evidenceAnswer(call: ModelCall, supported: boolean | ((id: string) => boolean) = true): ModelAnswer {
  const schema = (call.output as { kind: "json"; schema: any }).schema;
  const ids: string[] = schema?.properties?.results?.items?.properties?.id?.enum ?? [];
  const decide = typeof supported === "function" ? supported : () => supported;
  return { json: { results: ids.map((id) => ({ id, why: "stub", supported: decide(id) })) } };
}
