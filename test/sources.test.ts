/**
 * The sources themselves: what does not show on a page is written as an
 * escape, and no module is loaded by way of itself.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, posix, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * A character that does not show, by the three properties `shownName()` goes
 * by. A space is one too, and the one a source is written with.
 */
const UNSEEN = /[\p{White_Space}\p{Default_Ignorable_Code_Point}\p{Cc}]/gu;

/**
 * An import of types alone, in each shape it has: a name, a list in braces,
 * or a namespace, and the same re-exported. The statement is erased whole
 * (`verbatimModuleSyntax`), so it loads nothing.
 */
const TYPE_ONLY =
  /^(?:import|export)\s+type\s+(?:[\w$]+|\{[\w\s,$]*\}|\*(?:\s+as\s+[\w$]+)?)\s*from\s*["'][^"']+["']/gm;

/**
 * Whatever else names a module by a relative path: `from "./x.js"` of an
 * import or a re-export, `import "./x.js"`, `import("./x.js")`. It is read as
 * text, not as statements, so where it is wrong it has one module too many,
 * not one too few: a path in a comment counts. `import { type X }` counts by
 * right. That statement stays, with nothing in its braces, and loads the
 * module.
 */
const RELATIVE = /\b(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g;

/** Every source under `dir`, by its path from the root with `/` between the parts. */
function sources(dir: string): Map<string, string> {
  const entries = readdirSync(join(ROOT, dir), { recursive: true, encoding: "utf8" });
  return new Map(
    entries
      .filter((entry) => entry.endsWith(".ts"))
      .sort()
      .map((entry) => [
        `${dir}/${entry.split(sep).join("/")}`,
        readFileSync(join(ROOT, dir, entry), "utf8"),
      ]),
  );
}

/**
 * What each source loads of the others. An import of something that is no
 * source in the map is in `lost`: the walk cannot go on through it.
 */
function loads(texts: ReadonlyMap<string, string>): {
  graph: Map<string, string[]>;
  lost: string[];
} {
  const graph = new Map<string, string[]>();
  const lost: string[] = [];
  for (const [file, text] of texts) {
    const found = new Set<string>();
    for (const match of text.replace(TYPE_ONLY, "").matchAll(RELATIVE)) {
      const target = posix.join(posix.dirname(file), match[1]!).replace(/\.js$/, ".ts");
      if (texts.has(target)) found.add(target);
      else lost.push(`${file} -> ${target}`);
    }
    graph.set(file, [...found]);
  }
  return { graph, lost };
}

/** Each way a walk of the graph comes back to a module it is still inside, as `a -> b -> a`. */
function cycles(graph: ReadonlyMap<string, readonly string[]>): string[] {
  const found: string[] = [];
  const done = new Set<string>();
  const path: string[] = [];
  const visit = (file: string): void => {
    const at = path.indexOf(file);
    if (at !== -1) {
      found.push([...path.slice(at), file].join(" -> "));
      return;
    }
    if (done.has(file)) return;
    path.push(file);
    for (const next of graph.get(file) ?? []) visit(next);
    path.pop();
    done.add(file);
  };
  for (const file of graph.keys()) visit(file);
  return found;
}

describe("the sources", () => {
  it("hold no character that does not show, other than a space and a line end", () => {
    // Six no-break spaces stood in two test files, in strings that say
    // "nbsp": a space to the eye, in tests of what sets the two apart.
    const found: string[] = [];
    for (const dir of ["src", "test", "scripts"]) {
      const entries = readdirSync(join(ROOT, dir), { recursive: true, encoding: "utf8" });
      for (const file of entries.filter((entry) => /\.(ts|mjs)$/.test(entry)).sort()) {
        const lines = readFileSync(join(ROOT, dir, file), "utf8").split(/\r?\n/);
        lines.forEach((line, i) => {
          for (const [char] of line.matchAll(UNSEEN)) {
            if (char === " ") continue;
            const code = char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0");
            found.push(`${dir}/${file}:${i + 1} U+${code}`);
          }
        });
      }
    }
    expect(found).toEqual([]);
  });

  it("load no module by way of itself", () => {
    // `kind.ts` took `shownName()` from `thoughts.ts`, which takes
    // `requireKind()` from `kind.ts`. It ran, since each used the other
    // inside a function and nowhere else. The first use at the top of either
    // would have failed at load, or not, by which of the two was imported
    // first, and nothing said so beforehand.
    const { graph, lost } = loads(sources("src"));
    expect(graph.size).toBeGreaterThan(0);
    expect(lost).toEqual([]);
    expect(cycles(graph)).toEqual([]);
  });

  it("are read for each form of import that loads a module, and a cycle is found", () => {
    // In sources made up for it: the test above passes as well when the
    // reading misses an import, and when the walk misses a cycle.
    const made = new Map([
      ["src/a.ts", 'import { b } from "./b.js";\nimport type { D } from "./d.js";\n'],
      [
        "src/b.ts",
        'import {\n  c,\n  type C,\n} from "./deep/c.js";\nexport type { D } from "./d.js";\n',
      ],
      [
        "src/deep/c.ts",
        'export * from "../a.js";\nimport "./e.js";\nconst f = await import("../f.js");\n',
      ],
      [
        "src/d.ts",
        'import type * as a from "./a.js";\nimport type B from "./b.js";\n' +
          'import { type E } from "./deep/e.js";\nexport type * from "./a.js";\n',
      ],
      ["src/deep/e.ts", 'export type E = "from";\nimport { d } from "../d.js";\n'],
      ["src/f.ts", 'import { g } from "./g.js";\nimport { readFileSync } from "node:fs";\n'],
    ]);
    const { graph, lost } = loads(made);
    expect(Object.fromEntries(graph)).toEqual({
      "src/a.ts": ["src/b.ts"],
      "src/b.ts": ["src/deep/c.ts"],
      "src/deep/c.ts": ["src/a.ts", "src/deep/e.ts", "src/f.ts"],
      "src/d.ts": ["src/deep/e.ts"],
      "src/deep/e.ts": ["src/d.ts"],
      "src/f.ts": [],
    });
    expect(lost).toEqual(["src/f.ts -> src/g.ts"]);
    // With the imports of types counted there would be more, `a -> d -> a`
    // for one.
    expect(cycles(graph)).toEqual([
      "src/a.ts -> src/b.ts -> src/deep/c.ts -> src/a.ts",
      "src/deep/e.ts -> src/d.ts -> src/deep/e.ts",
    ]);
  });
});
