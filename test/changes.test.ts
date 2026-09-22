import { describe, expect, it } from "vitest";

import type { ModificationLogDto } from "../src/api/types.js";
import { describeChange, isSettingNoise, subjectIds } from "../src/operations/changes.js";

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

describe("subjectIds", () => {
  it("a thought event is about its source", () => {
    expect(subjectIds(thoughtCreated)).toEqual(["t1"]);
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
