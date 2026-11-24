import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { AppError } from "../../src/lib/errors";
import {
  claimJudge,
  commitTurn,
  planReservation,
  readSessionState,
  readCounters,
  recordAssistedKeys,
  recordNamedTerms,
  recordReachedKeys,
  refundTurn,
  releaseSolution,
  reserveTurn,
  revealNextHint,
  type TurnCounterKey,
} from "../../src/lib/turn-cap";

let counter = 0;
function freshKey(): TurnCounterKey {
  counter += 1;
  return { installId: `install-${counter}-${Date.now()}`, problemId: "vp-0001", date: "2026-08-20" };
}

async function expectAppError(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ code });
}

describe("reserveTurn()", () => {
  it("increments turns on each call and raises TURN_CAP_REACHED past the cap", async () => {
    const key = freshKey();
    const cap = 3;
    for (let i = 1; i <= cap; i++) {
      const result = await reserveTurn(env.DB, key, cap, 0);
      expect(result.turnIndex).toBe(i);
    }
    await expectAppError(reserveTurn(env.DB, key, cap, 0), "TURN_CAP_REACHED");
  });

  it("two concurrent calls yield distinct indices", async () => {
    const key = freshKey();
    const [a, b] = await Promise.all([
      reserveTurn(env.DB, key, 15, 0),
      reserveTurn(env.DB, key, 15, 0),
    ]);
    const indices = [a.turnIndex, b.turnIndex].sort();
    expect(indices).toEqual([1, 2]);
  });

  it("a turn-1 request claiming solution_request_count: 99 stores 1, and releaseSolution returns false", async () => {
    const key = freshKey();
    const result = await reserveTurn(env.DB, key, 15, 99);
    expect(result.turnIndex).toBe(1);
    expect(result.solutionRequests).toBe(1);
    expect(releaseSolution(result.turnIndex, result.solutionRequests)).toBe(false);
  });

  it("a client claiming 2 on every turn releases on turn 2 and never earlier", async () => {
    const key = freshKey();
    const turn1 = await reserveTurn(env.DB, key, 15, 2);
    expect(releaseSolution(turn1.turnIndex, turn1.solutionRequests)).toBe(false);
    expect(turn1.solutionRequests).toBe(1); // clamped to +1 despite claiming 2

    const turn2 = await reserveTurn(env.DB, key, 15, 2);
    expect(turn2.solutionRequests).toBe(2);
    expect(releaseSolution(turn2.turnIndex, turn2.solutionRequests)).toBe(true);
  });

  it("the stored solution_requests count never decreases when a later request claims a smaller number", async () => {
    const key = freshKey();
    await reserveTurn(env.DB, key, 15, 2); // stores 1
    const turn2 = await reserveTurn(env.DB, key, 15, 2); // stores 2
    expect(turn2.solutionRequests).toBe(2);
    const turn3 = await reserveTurn(env.DB, key, 15, 0); // claims 0, must not lower it
    expect(turn3.solutionRequests).toBe(2);
  });

  it("ignores anything resembling message count — it is not a parameter at all", async () => {
    // reserveTurn's signature has no messages/history parameter; the D1
    // counter is the only source of turnIndex, structurally.
    const key = freshKey();
    await reserveTurn(env.DB, key, 15, 0);
    await reserveTurn(env.DB, key, 15, 0);
    await reserveTurn(env.DB, key, 15, 0);
    const fourth = await reserveTurn(env.DB, key, 15, 0);
    expect(fourth.turnIndex).toBe(4);
  });
});

describe("readCounters()", () => {
  it("returns all zeroes and writes nothing for a fresh session", async () => {
    const key = freshKey();
    const before = await readCounters(env.DB, key);
    expect(before).toEqual({ turns: 0, solutionRequests: 0, hintsRevealed: 0, judgedAt: null });
    const after = await readCounters(env.DB, key);
    expect(after).toEqual(before);
  });
});

describe("revealNextHint() and claimJudge() create the row when none exists", () => {
  it("revealNextHint on a fresh session returns 1, never undefined", async () => {
    const key = freshKey();
    const first = await revealNextHint(env.DB, key);
    expect(first).toBe(1);
    const second = await revealNextHint(env.DB, key);
    expect(second).toBe(2);
  });

  it("claimJudge on a fresh session succeeds, never a spurious SESSION_ALREADY_JUDGED", async () => {
    const key = freshKey();
    const result = await claimJudge(env.DB, key);
    expect(result.judgedAt).toEqual(expect.any(String));
  });

  it("a second claimJudge for the same session raises SESSION_ALREADY_JUDGED", async () => {
    const key = freshKey();
    await claimJudge(env.DB, key);
    await expectAppError(claimJudge(env.DB, key), "SESSION_ALREADY_JUDGED");
  });
});

describe("refundTurn()", () => {
  it("returns the counter to its previous value so a retry reuses the same turn index", async () => {
    const key = freshKey();
    const turn1 = await reserveTurn(env.DB, key, 15, 0);
    expect(turn1.turnIndex).toBe(1);

    await refundTurn(env.DB, key, turn1.turnIndex);

    const retry = await reserveTurn(env.DB, key, 15, 0);
    expect(retry.turnIndex).toBe(1);
  });

  it("is a no-op once a later turn has already been reserved", async () => {
    const key = freshKey();
    const turn1 = await reserveTurn(env.DB, key, 15, 0);
    await reserveTurn(env.DB, key, 15, 0); // turn 2 reserved before the refund lands

    await refundTurn(env.DB, key, turn1.turnIndex); // stale index — must not touch turns=2

    const counters = await readCounters(env.DB, key);
    expect(counters.turns).toBe(2);
  });

  it("never lowers solution_requests", async () => {
    const key = freshKey();
    const turn1 = await reserveTurn(env.DB, key, 15, 5); // stores 1
    await refundTurn(env.DB, key, turn1.turnIndex);
    const counters = await readCounters(env.DB, key);
    expect(counters.solutionRequests).toBe(1);
  });
});

// Migration 0011, docs/tutor-focus-issues.md D11: authored never_say terms the
// progress check found the learner referred to, like reached_keys. Never
// learner text.
describe("named_terms", () => {
  it("the column exists once migrations are applied", async () => {
    const columns = await env.DB.prepare("PRAGMA table_info(device_day)").all<{ name: string }>();
    expect(columns.results.map((c) => c.name)).toContain("named_terms");
  });

  it("reserveTurn returns an empty list before anything is recorded", async () => {
    expect((await reserveTurn(env.DB, freshKey(), 15, 0)).namedTerms).toEqual([]);
  });

  it("recordNamedTerms stores the union and the next reserveTurn returns it", async () => {
    const key = freshKey();
    await reserveTurn(env.DB, key, 15, 0);
    await recordNamedTerms(env.DB, key, [], ["dp"]);
    expect((await reserveTurn(env.DB, key, 15, 0)).namedTerms).toEqual(["dp"]);
  });

  it("only ever grows: a later turn that names less takes nothing back", async () => {
    const key = freshKey();
    await reserveTurn(env.DB, key, 15, 0);
    await recordNamedTerms(env.DB, key, [], ["dp", "memoization"]);
    await recordNamedTerms(env.DB, key, ["dp", "memoization"], []);
    await recordNamedTerms(env.DB, key, ["dp", "memoization"], ["dp", "bfs"]);
    expect((await reserveTurn(env.DB, key, 15, 0)).namedTerms).toEqual(["dp", "memoization", "bfs"]);
  });

  it("writes nothing when nothing is new", async () => {
    const key = freshKey();
    await reserveTurn(env.DB, key, 15, 0);
    await recordNamedTerms(env.DB, key, [], []);
    const row = await env.DB.prepare("SELECT named_terms FROM device_day WHERE device_hash = ?1")
      .bind(key.installId)
      .first<{ named_terms: string | null }>();
    expect(row!.named_terms).toBeNull();
  });
});

// Migration 0012, PLAN_07 D4: authored insight keys the learner accepted from
// the tutor, like reached_keys. Never learner or tutor text.
describe("assisted_keys", () => {
  it("the column exists once migrations are applied", async () => {
    const columns = await env.DB.prepare("PRAGMA table_info(device_day)").all<{ name: string }>();
    expect(columns.results.map((c) => c.name)).toContain("assisted_keys");
  });

  it("reserveTurn returns an empty list before anything is recorded", async () => {
    expect((await reserveTurn(env.DB, freshKey(), 15, 0)).assistedKeys).toEqual([]);
  });

  it("recordAssistedKeys stores the union and the next reserveTurn returns it", async () => {
    const key = freshKey();
    await reserveTurn(env.DB, key, 15, 0);
    await recordAssistedKeys(env.DB, key, [], ["scan_in_array_order"]);
    expect((await reserveTurn(env.DB, key, 15, 0)).assistedKeys).toEqual(["scan_in_array_order"]);
  });

  it("only ever grows: a later turn that finds less takes nothing back", async () => {
    const key = freshKey();
    await reserveTurn(env.DB, key, 15, 0);
    await recordAssistedKeys(env.DB, key, [], ["a", "b"]);
    await recordAssistedKeys(env.DB, key, ["a", "b"], []);
    await recordAssistedKeys(env.DB, key, ["a", "b"], ["a", "c"]);
    expect((await reserveTurn(env.DB, key, 15, 0)).assistedKeys).toEqual(["a", "b", "c"]);
  });

  it("writes nothing when nothing is new", async () => {
    const key = freshKey();
    await reserveTurn(env.DB, key, 15, 0);
    await recordAssistedKeys(env.DB, key, [], []);
    const row = await env.DB.prepare("SELECT assisted_keys FROM device_day WHERE device_hash = ?1")
      .bind(key.installId)
      .first<{ assisted_keys: string | null }>();
    expect(row!.assisted_keys).toBeNull();
  });
});

describe("planReservation()", () => {
  it("matches reserveTurn() on every step of a session, including the solution-request clamp", async () => {
    for (const claims of [[0, 0, 0], [99, 99, 99], [2, 2, 2], [0, 5, 0]]) {
      const key = freshKey();
      for (const claimed of claims) {
        const planned = planReservation(await readCounters(env.DB, key), 15, claimed);
        const real = await reserveTurn(env.DB, key, 15, claimed);
        expect(planned).toEqual({ turnIndex: real.turnIndex, solutionRequests: real.solutionRequests });
      }
    }
  });

  it("throws TURN_CAP_REACHED when the planned index passes the cap", () => {
    expect(() => planReservation({ turns: 3, solutionRequests: 0 }, 3, 0)).toThrowError(AppError);
    expect(() => planReservation({ turns: 2, solutionRequests: 0 }, 3, 0)).not.toThrow();
  });
});

describe("commitTurn()", () => {
  it("is idempotent per turn_key: twice spends one turn and returns the same index", async () => {
    const key = freshKey();
    const a = await commitTurn(env.DB, key, 15, 0, "turn-a", 1);
    const b = await commitTurn(env.DB, key, 15, 0, "turn-a", 1);
    expect(a.turnIndex).toBe(1);
    expect(b.turnIndex).toBe(1);
    expect((await readCounters(env.DB, key)).turns).toBe(1);
    const state = await readSessionState(env.DB, key);
    expect(state.lastTurnKey).toBe("turn-a");
    expect(state.lastTurnIndex).toBe(1);
  });

  it("commits successive turns with the arithmetic of reserveTurn()", async () => {
    const key = freshKey();
    const t1 = await commitTurn(env.DB, key, 15, 99, "t1", 1);
    expect(t1.solutionRequests).toBe(1);
    const t2 = await commitTurn(env.DB, key, 15, 99, "t2", 2);
    expect(t2.turnIndex).toBe(2);
    expect(t2.solutionRequests).toBe(2);
  });

  it("a wrong planned index is STEP_DIVERGED and writes nothing", async () => {
    const key = freshKey();
    await commitTurn(env.DB, key, 15, 0, "t1", 1);
    await expectAppError(commitTurn(env.DB, key, 15, 0, "t-stale", 1), "STEP_DIVERGED");
    await expectAppError(commitTurn(env.DB, key, 15, 0, "t-ahead", 5), "STEP_DIVERGED");
    expect((await readCounters(env.DB, key)).turns).toBe(1);
  });

  it("at the cap it is TURN_CAP_REACHED and writes nothing", async () => {
    const key = freshKey();
    await commitTurn(env.DB, key, 2, 0, "t1", 1);
    await commitTurn(env.DB, key, 2, 0, "t2", 2);
    await expectAppError(commitTurn(env.DB, key, 2, 0, "t3", 3), "TURN_CAP_REACHED");
    expect((await readCounters(env.DB, key)).turns).toBe(2);
  });

  it("two commits racing for the same planned index: one wins, the other diverges", async () => {
    const key = freshKey();
    const results = await Promise.allSettled([
      commitTurn(env.DB, key, 15, 0, "x", 1),
      commitTurn(env.DB, key, 15, 0, "y", 1),
    ]);
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
    expect((await readCounters(env.DB, key)).turns).toBe(1);
  });
});
