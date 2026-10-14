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
  indexModelId,
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

  it("the local embedder says whether the package is there, asked before a build", async () => {
    // What a rebuild asks before it reads a brain: without the package it
    // used to read all of it and fail at the first document.
    await expect(new LocalEmbedder().isAvailable()).resolves.toBe(packageInstalled);
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

  describe("a package that is there and does not load", () => {
    // Every failure of the import was "is not installed", and its cause was
    // printed nowhere: a broken install read as an absent one.
    const ABSENT = new EmbedderUnavailableError().message;
    /** What Node's import throws for a package it does not find, as `imported from` has it. */
    const notFound = (name: string, from: string): Error =>
      Object.assign(new Error(`Cannot find package '${name}' imported from ${from}`), {
        code: "ERR_MODULE_NOT_FOUND",
      });

    it("is told as a package that failed to load, with what the import failed by", () => {
      const broken = new EmbedderUnavailableError(
        new Error("dlopen(onnxruntime_binding.node, 0x0001): Library not loaded."),
      );
      expect(broken.loadFailure).toBe(
        "dlopen(onnxruntime_binding.node, 0x0001): Library not loaded",
      );
      expect(broken.message).toBe(
        "semantic search is off: the @huggingface/transformers package failed to load: " +
          "dlopen(onnxruntime_binding.node, 0x0001): Library not loaded. Substring name " +
          "search is available without it.",
      );
      expect(broken.message).not.toMatch(/not installed|380 MB/);
    });

    it("so is a package of its own that it does not find", () => {
      // The same code as for the package itself, and another name in it.
      const broken = new EmbedderUnavailableError(
        notFound(
          "onnxruntime-node",
          "/usr/lib/node_modules/@huggingface/transformers/dist/transformers.node.mjs",
        ),
      );
      expect(broken.loadFailure).toMatch(/^Cannot find package 'onnxruntime-node' imported from /);
      expect(broken.message).toMatch(/package failed to load: Cannot find package 'onnxruntime-node'/);
    });

    it("the package itself not found is not installed, as with no cause given", () => {
      for (const cause of [
        // Node 22.15, measured: with no quotes around the importer, and under Vitest with.
        notFound("@huggingface/transformers", "/srv/dist/semantic/embedder.js"),
        notFound("@huggingface/transformers", "'/srv/src/semantic/embedder.ts'"),
        // A `require`, and the module Vite puts in place of an optional peer dependency.
        new Error("Cannot find module '@huggingface/transformers'\nRequire stack:\n- /srv/x.cjs"),
        new Error(
          'Could not resolve "@huggingface/transformers" imported by "thebrain-mcp-server". Is it installed?',
        ),
      ]) {
        const absent = new EmbedderUnavailableError(cause);
        expect(absent.loadFailure, cause.message).toBeNull();
        expect(absent.message).toBe(ABSENT);
      }
      expect(new EmbedderUnavailableError().loadFailure).toBeNull();
      expect(ABSENT).toMatch(/package is not installed\. It weighs about 380 MB/);
    });

    it("what is thrown is kept as the cause either way", () => {
      const cause = new Error("boom");
      expect(new EmbedderUnavailableError(cause).cause).toBe(cause);
      expect(new EmbedderUnavailableError("a string, not an error").loadFailure).toBe(
        "a string, not an error",
      );
    });

    it.skipIf(packageInstalled)(
      "without the package, the import's own failure is read as not installed",
      async () => {
        // What Node says of a package that is not there is what tells the two apart.
        const why = await new LocalEmbedder().whyUnavailable();
        expect(why).toBeInstanceOf(EmbedderUnavailableError);
        expect(why!.loadFailure).toBeNull();
        expect(why!.message).toBe(ABSENT);
        const thrown = await new LocalEmbedder().embedQuery("probe").catch((e: unknown) => e);
        expect((thrown as EmbedderUnavailableError).loadFailure).toBeNull();
      },
    );

    it.skipIf(!packageInstalled)("with the package there is nothing to say why", async () => {
      await expect(new LocalEmbedder().whyUnavailable()).resolves.toBeNull();
    });
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

  it("aliases follow the name, ahead of everything else", () => {
    const doc = buildDocument({
      id: "1",
      name: "RAG",
      kind: 1,
      aliases: ["Retrieval-augmented generation", "генерация с дополненной выборкой"],
      label: "pattern",
      typeName: "Concept",
      note: "retrieve, then generate",
    });
    expect(doc.split("\n").slice(0, 3)).toEqual([
      "RAG",
      "Retrieval-augmented generation, генерация с дополненной выборкой",
      "pattern",
    ]);
  });

  it("a label is a line of the document as the API reads it, a type's included", () => {
    // A type nobody gave a label reads with its name for one, and after a
    // rename with the name it had (contract test; docs/api-map.md, L38). The
    // document keeps both as they come: it is TheBrain's label, its search
    // finds the type by it, and no read tells it from a caption. Dropping it
    // would be a new DOCUMENT_FORMAT, and every index built again.
    expect(buildDocument({ id: "1", name: "Tool", kind: 2, label: "Tool" })).toBe("Tool\nTool");
    expect(buildDocument({ id: "1", name: "Instrument", kind: 2, label: "Tool" })).toBe(
      "Instrument\nTool",
    );
    // Removed, which is what takes the old name out, it leaves the name alone.
    expect(buildDocument({ id: "1", name: "Instrument", kind: 2, label: null })).toBe("Instrument");
    expect(indexModelId("e5")).toBe("e5#doc3");
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
      aliases: [],
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
