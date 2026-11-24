import { describe, expect, it } from "vitest";
import { getPrivate, getPublicManifest } from "../../src/lib/content";
import { toGeminiSchema } from "../../src/lib/gemini-schema";
import { buildJudgeSchema } from "../../src/lib/judge-schema";
import { finishCheckSchema } from "../../src/lib/finish-check";
import { evidenceCheckSchema } from "../../src/lib/judge-evidence";
import type { Problem } from "../../../tools/problem-types";

const ALLOWED = new Set(["type", "properties", "required", "items", "enum", "nullable"]);

function assertSubset(node: any, path = "$"): void {
  for (const key of Object.keys(node)) expect(ALLOWED.has(key), `${path}.${key}`).toBe(true);
  expect(typeof node.type).toBe("string");
  expect(Array.isArray(node.type)).toBe(false);
  for (const [name, sub] of Object.entries(node.properties ?? {})) assertSubset(sub, `${path}.${name}`);
  if (node.items) assertSubset(node.items, `${path}[]`);
}

const problems: Problem[] = getPublicManifest().problems.map((pub) => ({ public: pub, private: getPrivate(pub.id)! }));

describe("toGeminiSchema()", () => {
  it("converts every shipped problem's judge, finish-check and evidence schemas into the allowed subset", () => {
    expect(problems.length).toBeGreaterThan(0);
    for (const problem of problems) {
      assertSubset(toGeminiSchema(buildJudgeSchema(problem)));
      assertSubset(toGeminiSchema(finishCheckSchema(problem).schema));
    }
    assertSubset(toGeminiSchema(evidenceCheckSchema(["a", "b"]).schema));
  });

  it("turns type unions with null into nullable and keeps enums", () => {
    const out: any = toGeminiSchema(buildJudgeSchema(problems[0]!));
    expect(out.properties.complexity.properties.user_claimed_time).toEqual({ type: "string", nullable: true });
    expect(out.properties.matched_approach.enum).toContain("none");
    expect(out.additionalProperties).toBeUndefined();
  });

  it("throws on keywords outside the subset", () => {
    expect(() => toGeminiSchema({ type: "string", pattern: "x" })).toThrow();
    expect(() => toGeminiSchema({ type: ["string", "number"] })).toThrow();
    expect(() => toGeminiSchema({ $ref: "#/x" })).toThrow();
  });
});
