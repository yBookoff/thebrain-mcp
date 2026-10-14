import { describe, expect, it } from "vitest";

import type { ModificationLogDto } from "../src/api/types.js";
import { linkedIn, roundsApart, sweepFrom, sweepTargets } from "./sweep.js";

/** Shapes as the live API records them; see src/semantic/indexer.ts, `linkEndIds`. */
const entry = (over: Partial<ModificationLogDto>): ModificationLogDto => ({
  sourceId: "source",
  sourceType: 2,
  extraAId: "",
  extraAType: -1,
  extraBId: "",
  extraBType: -1,
  modType: 101,
  oldValue: null,
  newValue: null,
  userId: "u",
  brainId: "b",
  creationDateTime: "2026-10-14T09:43:43.863798",
  modificationDateTime: "2026-10-14T09:43:43.863798",
  syncUpdateDateTime: null,
  ...over,
});
const made = (id: string): ModificationLogDto => entry({ sourceId: id });
const gone = (id: string): ModificationLogDto => entry({ sourceId: id, modType: 102 });
const link = (a: string, b: string, modType = 101): ModificationLogDto =>
  entry({
    sourceId: `${a}-${b}`,
    sourceType: 3,
    extraAId: a,
    extraAType: 2,
    extraBId: b,
    extraBType: 2,
    modType,
  });

describe("the sweep after a contract run", () => {
  it("starts past the newest entry logged before the run, to the millisecond", () => {
    // The home thought of a brain made 34 s before a run, as zz-mcp-51b's was.
    const home = entry({ modificationDateTime: "2026-10-14T09:43:43.863798" });
    const from = sweepFrom(home, "2026-10-14T09:43:18.000Z");
    expect(from).toBe("2026-10-14T09:43:43.864Z");
    expect(Date.parse(from)).toBeGreaterThan(Date.parse("2026-10-14T09:43:43.863Z"));
    // A time with its trailing zeros trimmed, and one with no fraction.
    expect(sweepFrom(entry({ modificationDateTime: "2026-09-30T13:48:59.6" }), "x")).toBe(
      "2026-09-30T13:48:59.601Z",
    );
    expect(sweepFrom(entry({ modificationDateTime: "2026-09-30T13:48:59" }), "x")).toBe(
      "2026-09-30T13:48:59.001Z",
    );
    // Nothing logged in the minute before: the minute will do.
    expect(sweepFrom(undefined, "2026-10-14T09:43:18.000Z")).toBe("2026-10-14T09:43:18.000Z");
  });

  it("never takes the home thought, though the log has it as made", () => {
    const logs = [made("home"), made("a"), made("b"), gone("b"), made("c")];
    expect(sweepTargets(logs, [], "home")).toEqual(["a", "c"]);
    expect(sweepTargets(logs, ["home", "x", "a"], "home")).toEqual(["x", "a", "c"]);
  });

  it("puts no two thoughts that share a link in one round", () => {
    const logs = [
      // A parent with three children, a type with two instances, a tag on one.
      link("p", "c1"),
      link("p", "c2"),
      link("p", "c3"),
      link("type", "i1"),
      link("type", "i2"),
      link("tag", "c1"),
      // A link deleted since still counts: the two shared it.
      link("x", "y"),
      link("x", "y", 102),
      // A ring of three.
      link("r1", "r2"),
      link("r2", "r3"),
      link("r3", "r1"),
      // Not a link: a thought's own entries name no second thought.
      made("lone"),
    ];
    const near = linkedIn(logs);
    expect([...near.get("c1")!].sort()).toEqual(["p", "tag"]);

    const ids = ["p", "c1", "c2", "c3", "type", "i1", "i2", "tag", "x", "y", "r1", "r2", "r3", "lone"];
    const rounds = roundsApart(ids, near);
    expect(rounds).toEqual([
      ["p", "type", "tag", "x", "r1", "lone"],
      ["c1", "c2", "c3", "i1", "i2", "y", "r2"],
      ["r3"],
    ]);
    for (const round of rounds) {
      for (const a of round) for (const b of round) expect(near.get(a)?.has(b) ?? false, `${a} ${b}`).toBe(false);
    }
    expect(rounds.flat().sort()).toEqual([...ids].sort());
    // Children first, and the parent still has a round of its own.
    expect(roundsApart(["c1", "c2", "p"], near)).toEqual([["c1", "c2"], ["p"]]);
  });
});
