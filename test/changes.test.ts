import { describe, expect, it } from "vitest";

import type { ModificationLogDto } from "../src/api/types.js";
import {
  LOG_NAME_LIMIT,
  describeChange,
  isSettingNoise,
  loggedThoughts,
  subjectIds,
} from "../src/operations/changes.js";

/** Shapes as the live API records them; see src/operations/changes.ts. */
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
  creationDateTime: "2026-09-22T16:58:00",
  modificationDateTime: "2026-09-22T16:58:00",
  syncUpdateDateTime: null,
  ...over,
});

const thoughtCreated = entry({ sourceId: "t1", sourceType: 2, modType: 101 });
const linkCreated = entry({
  sourceId: "link-1",
  sourceType: 3,
  extraAId: "t1",
  extraAType: 2,
  extraBId: "t2",
  extraBType: 2,
  modType: 101,
});
const linkRelabelled = { ...linkCreated, modType: 103, newValue: "is checked with" };
const noteChanged = entry({
  sourceId: "notes-md",
  sourceType: 4,
  extraAId: "t1",
  extraAType: 2,
  modType: 803,
});
const urlAttached = { ...noteChanged, sourceId: "att-1", modType: 101 };
const wallpaper = entry({ sourceId: "wall", sourceType: 4, extraAId: "brain", extraAType: 1 });
const viewZoomed = entry({ sourceId: "setting", sourceType: 5, modType: 601 });
const aliasesChanged = entry({ sourceId: "t1", sourceType: 2, modType: 211 });

describe("subjectIds", () => {
  it("a thought event is about its source", () => {
    expect(subjectIds(thoughtCreated)).toEqual(["t1"]);
    expect(subjectIds(aliasesChanged)).toEqual(["t1"]);
  });

  it("a link event is about both ends, not the unnamed link", () => {
    expect(subjectIds(linkCreated)).toEqual(["t1", "t2"]);
  });

  it("an attachment or note event is about the thought in extraA", () => {
    expect(subjectIds(noteChanged)).toEqual(["t1"]);
    expect(subjectIds(urlAttached)).toEqual(["t1"]);
  });

  it("a brain-level attachment and a setting name no thought", () => {
    expect(subjectIds(wallpaper)).toEqual([]);
    expect(subjectIds(viewZoomed)).toEqual([]);
  });
});

describe("describeChange", () => {
  it("a thought keeps the bare description", () => {
    expect(describeChange(thoughtCreated)).toBe("created");
  });

  it("a generic code on a link or attachment names the entity", () => {
    // Regression: a bare "created" on a link read as a new thought.
    expect(describeChange(linkCreated)).toBe("link created");
    expect(describeChange(linkRelabelled)).toBe("link renamed");
    expect(describeChange(urlAttached)).toBe("attachment created");
  });

  it("a code that already says what it is about is left alone", () => {
    expect(describeChange(noteChanged)).toBe("note changed");
    expect(describeChange(aliasesChanged)).toBe("aliases changed");
  });
});

describe("isSettingNoise", () => {
  it("only brain-setting events are noise", () => {
    expect(isSettingNoise(viewZoomed)).toBe(true);
    for (const e of [thoughtCreated, linkCreated, noteChanged, wallpaper]) {
      expect(isSettingNoise(e)).toBe(false);
    }
  });
});

describe("loggedThoughts", () => {
  /** A thought's own entry at a second of one minute, as the live API logs it. */
  const at = (second: number, over: Partial<ModificationLogDto>): ModificationLogDto => {
    const time = `2026-10-11T10:00:${String(second).padStart(2, "0")}`;
    return entry({ sourceId: "t1", creationDateTime: time, modificationDateTime: time, ...over });
  };
  const created = at(1, { modType: 101, newValue: "Draft" });
  const renamed = at(2, { modType: 103, oldValue: "Draft", newValue: "Final" });
  const deleted = at(3, { modType: 102, oldValue: "Final" });

  it("a created thought has the name of its 101", () => {
    expect(loggedThoughts([created]).get("t1")).toEqual({
      name: "Draft",
      cut: false,
      deleted: false,
    });
  });

  it("a renamed one has the new name, whichever way the entries are ordered", () => {
    const want = { name: "Final", cut: false, deleted: false };
    expect(loggedThoughts([created, renamed]).get("t1")).toEqual(want);
    expect(loggedThoughts([renamed, created]).get("t1")).toEqual(want);
    // The rename alone: the thought was created before what was read.
    expect(loggedThoughts([renamed]).get("t1")).toEqual(want);
  });

  it("a deleted one is deleted, under the name it had last", () => {
    const want = { name: "Final", cut: false, deleted: true };
    expect(loggedThoughts([deleted, renamed, created]).get("t1")).toEqual(want);
    expect(loggedThoughts([deleted]).get("t1")).toEqual(want);
  });

  it("a deletion whose entry has no name keeps the name read before it", () => {
    const bare = at(3, { modType: 102, oldValue: null });
    expect(loggedThoughts([bare, created]).get("t1")).toEqual({
      name: "Draft",
      cut: false,
      deleted: true,
    });
    expect(loggedThoughts([bare]).get("t1")).toEqual({ name: null, cut: false, deleted: true });
  });

  it("entries of one time are taken as created, renamed, deleted", () => {
    const same = (over: Partial<ModificationLogDto>): ModificationLogDto => at(5, over);
    const three = [
      same({ modType: 102, oldValue: "Final" }),
      same({ modType: 101, newValue: "Draft" }),
      same({ modType: 103, oldValue: "Draft", newValue: "Final" }),
    ];
    expect(loggedThoughts(three).get("t1")).toEqual({ name: "Final", cut: false, deleted: true });
  });

  it("times are compared to the microsecond, not as text", () => {
    // ".5" is half a second, later than ".49999".
    const early = entry({
      sourceId: "t1",
      modType: 103,
      newValue: "Earlier",
      modificationDateTime: "2026-10-11T10:00:00.49999",
    });
    const late = entry({
      sourceId: "t1",
      modType: 103,
      newValue: "Later",
      modificationDateTime: "2026-10-11T10:00:00.5",
    });
    expect(loggedThoughts([late, early]).get("t1")?.name).toBe("Later");
    expect(loggedThoughts([early, late]).get("t1")?.name).toBe("Later");
  });

  it("a name as long as the log keeps one is marked as one that may be cut", () => {
    const whole = "n".repeat(LOG_NAME_LIMIT - 1);
    expect(loggedThoughts([at(1, { newValue: whole })]).get("t1")).toMatchObject({ cut: false });
    const full = "n".repeat(LOG_NAME_LIMIT);
    expect(loggedThoughts([at(1, { newValue: full })]).get("t1")).toEqual({
      name: full,
      cut: true,
      deleted: false,
    });
  });

  it("only a thought's own created, renamed and deleted entries name it", () => {
    const others = [
      // A link's values are its label, an attachment's its own name or address,
      // and a type set carries the name of the type.
      { ...linkRelabelled, extraAId: "t1", extraBId: "t2" },
      entry({ sourceId: "link-1", sourceType: 3, extraAId: "t1", extraAType: 2, modType: 102, oldValue: "see" }),
      entry({ sourceId: "att-1", sourceType: 4, extraAId: "t1", extraAType: 2, modType: 102, oldValue: "Notes.md" }),
      entry({ sourceId: "t1", modType: 203, newValue: "Pattern" }),
      entry({ sourceId: "t1", modType: 202, newValue: "a label" }),
      entry({ sourceId: "t1", modType: 304, oldValue: "Normal", newValue: "Tag" }),
    ];
    expect(loggedThoughts(others).size).toBe(0);
    expect(loggedThoughts([...others, at(9, { sourceId: "t2", newValue: "Other" })])).toEqual(
      new Map([["t2", { name: "Other", cut: false, deleted: false }]]),
    );
  });

  it("a thought created again after its deletion is there", () => {
    const again = at(4, { modType: 101, newValue: "Back" });
    expect(loggedThoughts([created, deleted, again]).get("t1")).toEqual({
      name: "Back",
      cut: false,
      deleted: false,
    });
  });
});
