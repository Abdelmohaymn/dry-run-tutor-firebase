// Shared plumbing of the three step routes (/v2/turn, /v2/judge, /v2/repair):
// bounded body parsing, the problem lookup, and the two response shapes.
import type { Context } from "hono";
import type { ZodType } from "zod";
import { AppError } from "./errors";
import { STEP_BODY_MAX_CHARS } from "./schemas";
import { getPrivate, getPublicManifest } from "./content";
import { NeedModel } from "./step-port";
import type { Problem } from "../../../tools/problem-types";

/** Reads the body (≤ 256 KB) and validates it; anything off is BAD_REQUEST. */
export async function readStepBody<T>(c: Context, schema: ZodType<T>): Promise<T> {
  const raw = await c.req.text().catch(() => null);
  if (raw === null || raw.length > STEP_BODY_MAX_CHARS) throw new AppError("BAD_REQUEST");
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new AppError("BAD_REQUEST");
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new AppError("BAD_REQUEST");
  return parsed.data;
}

/** Both halves of a shipped problem, or BAD_REQUEST. */
export function requireProblem(problemId: string): Problem {
  const publicEntry = getPublicManifest().problems.find((p) => p.id === problemId);
  const privateHalf = getPrivate(problemId);
  if (!publicEntry || !privateHalf) throw new AppError("BAD_REQUEST");
  return { public: publicEntry, private: privateHalf };
}

/** `status: "model"` — the pipeline needs these answers before it can go on. */
export function modelResponse(c: Context, need: NeedModel): Response {
  return c.json({ status: "model", calls: need.calls }, 200);
}
