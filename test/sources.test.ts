/**
 * The sources themselves: what does not show on a page is written as an escape.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * A character that does not show, by the three properties `shownName()` goes
 * by. A space is one too, and the one a source is written with.
 */
const UNSEEN = /[\p{White_Space}\p{Default_Ignorable_Code_Point}\p{Cc}]/gu;

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
});
