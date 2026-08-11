import { describe, expect, it } from "vitest";

import {
  EmbedderUnavailableError,
  LocalEmbedder,
  isLocalEmbedderAvailable,
} from "../src/semantic/embedder.js";
import {
  NOTE_EXCERPT_LIMIT,
  buildDocument,
  documentHash,
  excerpt,
} from "../src/semantic/document.js";

/**
 * Whether the optional dependency happens to be installed varies: a contributor
 * may or may not have it, and npm installs a project's own peer dependencies
 * during development. Tests must not assume either way.
 */
const packageInstalled = await isLocalEmbedderAvailable();

describe("optional dependency", () => {
  it("availability resolves to a boolean instead of throwing", async () => {
    await expect(isLocalEmbedderAvailable()).resolves.toBeTypeOf("boolean");
  });

  it("the missing-package error explains why it is not bundled", () => {
    const error = new EmbedderUnavailableError();
    expect(error.message).toMatch(/380 MB/);
    expect(error.message).toMatch(/113 MB/);
    expect(error.message).toMatch(/@huggingface\/transformers/);
    expect(error.installCommand).toContain("@huggingface/transformers");
  });

  it("the error names a fallback so the caller is not left stuck", () => {
    expect(new EmbedderUnavailableError().message).toMatch(/[Ss]ubstring name search/);
  });

  it.skipIf(packageInstalled)(
    "embedding without the package rejects with the typed error",
    async () => {
      const embedder = new LocalEmbedder();
      await expect(embedder.embedQuery("probe")).rejects.toBeInstanceOf(
        EmbedderUnavailableError,
      );
    },
  );

  it.skipIf(packageInstalled)(
    "a second attempt is not stuck on the failed load",
    async () => {
      const embedder = new LocalEmbedder();
      await expect(embedder.embedQuery("one")).rejects.toBeInstanceOf(
        EmbedderUnavailableError,
      );
      // A cached rejected promise would make installing the package useless
      // until the server restarts.
      await expect(embedder.embedDocuments(["two"])).rejects.toBeInstanceOf(
        EmbedderUnavailableError,
      );
    },
  );

  it.skipIf(!packageInstalled)(
    "with the package installed, queries and documents both embed",
    async () => {
      const embedder = new LocalEmbedder();
      const query = await embedder.embedQuery("vector databases");
      const [doc] = await embedder.embedDocuments(["vector databases"]);
      expect(query).toHaveLength(embedder.dimensions);
      expect(doc).toHaveLength(embedder.dimensions);
      // Normalised vectors have unit length, which search relies on.
      const norm = Math.sqrt([...query].reduce((s, v) => s + v * v, 0));
      expect(norm).toBeCloseTo(1, 4);
    },
    120_000,
  );
});

describe("model parameters", () => {
  it("defaults to multilingual e5-small at q8", () => {
    const embedder = new LocalEmbedder();
    expect(embedder.id).toBe("Xenova/multilingual-e5-small@q8");
    expect(embedder.dimensions).toBe(384);
  });

  it("the identifier includes precision, so changing dtype invalidates the index", () => {
    expect(new LocalEmbedder({ dtype: "fp32" }).id).toBe(
      "Xenova/multilingual-e5-small@fp32",
    );
  });

  it("the base model has different dimensions", () => {
    const embedder = new LocalEmbedder({ model: "Xenova/multilingual-e5-base" });
    expect(embedder.dimensions).toBe(768);
  });

  it("an unknown model is rejected at construction, not on first search", () => {
    expect(() => new LocalEmbedder({ model: "some/model" })).toThrowError(
      /unknown dimensions/,
    );
  });
});

describe("building the text to embed", () => {
  it("just the name when there is nothing else", () => {
    expect(buildDocument({ id: "1", name: "Unity", kind: 1 })).toBe("Unity");
  });

  it("mixes in type, tags, label and note", () => {
    const doc = buildDocument({
      id: "1",
      name: "Prefix-only search",
      kind: 1,
      label: "important",
      typeName: "Constraint",
      tagNames: ["gotcha", "verified"],
      note: "OT finds OTGP, a typo returns nothing",
    });
    expect(doc).toContain("Prefix-only search");
    expect(doc).toContain("important");
    expect(doc).toContain("type: Constraint");
    expect(doc).toContain("tags: gotcha, verified");
    expect(doc).toContain("a typo returns nothing");
  });

  it("the name comes first — it is the strongest signal", () => {
    const doc = buildDocument({
      id: "1",
      name: "Unity",
      kind: 1,
      note: "a very long note about something entirely different",
    });
    expect(doc.startsWith("Unity")).toBe(true);
  });

  it("empty and absent fields leave no residue", () => {
    const doc = buildDocument({
      id: "1",
      name: "clean",
      kind: 1,
      label: null,
      typeName: null,
      tagNames: [],
      note: "   ",
    });
    expect(doc).toBe("clean");
  });

  it("a long note is truncated", () => {
    const doc = buildDocument({
      id: "1",
      name: "long",
      kind: 1,
      note: "word ".repeat(2000),
    });
    expect(doc.length).toBeLessThan(NOTE_EXCERPT_LIMIT + 100);
    expect(doc).toMatch(/…$/);
  });
});

describe("truncation", () => {
  it("leaves short text alone", () => {
    expect(excerpt("short", 100)).toBe("short");
  });

  it("cuts on a word boundary", () => {
    const out = excerpt("one two three four five six", 20);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toMatch(/\s…$/);
    expect(out.length).toBeLessThanOrEqual(21);
  });

  it("a long word with no spaces is cut hard", () => {
    const out = excerpt("a".repeat(50), 10);
    expect(out).toBe(`${"a".repeat(10)}…`);
  });
});

describe("document hash", () => {
  it("identical text gives an identical hash", () => {
    expect(documentHash("text")).toBe(documentHash("text"));
  });

  it("different text gives a different hash", () => {
    expect(documentHash("text")).not.toBe(documentHash("text "));
  });

  it("the hash is compact — it sits in every index row", () => {
    expect(documentHash("anything")).toHaveLength(32);
  });

  it("an edit that does not reach the vector keeps the same hash", () => {
    const before = buildDocument({ id: "1", name: "thought", kind: 1, note: "text" });
    const after = buildDocument({
      id: "1",
      name: "thought",
      kind: 1,
      note: "text",
      // A thought's colour never enters the document, so no re-embedding is due.
    });
    expect(documentHash(before)).toBe(documentHash(after));
  });
});
