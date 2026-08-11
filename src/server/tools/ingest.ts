/**
 * Batch write: moves a decomposed structure into the brain in one call.
 */

import { z } from "zod";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { warnIfFencedCode } from "../../api/index.js";
import { IngestValidationError, ingest } from "../../operations/ingest.js";
import type { ServerContext } from "../context.js";
import { bullet, fail, guard, join, ok, section, table } from "../respond.js";

const relation = z
  .enum(["child", "parent", "jump", "sibling"])
  .describe("How this thought relates to its parent. Usually child.");

export function registerIngestTool(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "brain_ingest",
    {
      description:
        "Writes a whole structure of thoughts, links, notes and tags in a single call. " +
        "Call it once you have decomposed some material (an article, a document, a " +
        "discussion) into several connected thoughts — creating them one by one at that " +
        "volume is slow and breaks halfway.\n" +
        "Thoughts reference each other by tempId, arbitrary labels you invent yourself; " +
        "the server substitutes real identifiers. A parent may be either a tempId from " +
        "this batch or the UUID of an existing thought, which is how a new branch grafts " +
        "onto what the brain already holds.\n" +
        "Search with brain_search first: some of the thoughts may already exist, and " +
        "linking to them beats creating duplicates.",
      inputSchema: {
        brainId: z
          .string()
          .describe("Brain identifier. Take it from brain_list — never guess it."),
        thoughts: z
          .array(
            z.object({
              tempId: z
                .string()
                .describe('Label for references within this batch, e.g. "rag" or "t1".'),
              name: z.string().min(1).describe("Thought title."),
              note: z.string().optional().describe("Note in Markdown."),
              parent: z
                .string()
                .optional()
                .describe(
                  "A tempId from this batch or the UUID of an existing thought. " +
                    "Without it the thought is left unlinked.",
                ),
              relation: relation.optional(),
              typeId: z.string().optional().describe("Type from brain_list_types_and_tags."),
              tagIds: z.array(z.string()).optional().describe("Tags by identifier."),
              label: z.string().optional(),
            }),
          )
          .min(1)
          .max(200)
          .describe("The batch's thoughts. Order does not matter; dependencies resolve themselves."),
        links: z
          .array(
            z.object({
              from: z.string().describe("tempId or UUID."),
              to: z.string().describe("tempId or UUID."),
              relation: relation.optional().describe("Defaults to jump."),
              name: z
                .string()
                .optional()
                .describe('Link label: "motivates", "contradicts", "solved by".'),
            }),
          )
          .optional()
          .describe(
            "Extra links on top of the hierarchy. These are what turn a set of thoughts " +
              "into a graph — use them freely and label them.",
          ),
        deduplicate: z
          .boolean()
          .optional()
          .describe(
            "Skip creating a thought when the same parent already has a child with that " +
              "name. On by default, which makes re-running a batch safe.",
          ),
      },
    },
    guard(async ({ brainId, thoughts, links, deduplicate }) => {
      let outcome;
      try {
        outcome = await ingest(ctx.api, brainId, {
          thoughts,
          ...(links !== undefined ? { links } : {}),
          ...(deduplicate !== undefined ? { deduplicate } : {}),
        });
      } catch (error) {
        if (error instanceof IngestValidationError) {
          return fail(
            `Plan rejected, nothing was written: ${error.message}. Fix it and retry.`,
          );
        }
        throw error;
      }

      const fenceWarnings = thoughts
        .filter((t) => t.note !== undefined && warnIfFencedCode(t.note) !== null)
        .map((t) => t.name);

      const rows = [
        ...outcome.created.map((c) => ["created", c.name, c.thoughtId]),
        ...outcome.reused.map((r) => ["existed", r.name, r.thoughtId]),
      ];

      return ok(
        join([
          section("Thoughts", table(["Outcome", "Title", "Identifier"], rows)),
          section(
            "Also",
            bullet([
              `links created: ${outcome.linksCreated}`,
              `notes written: ${outcome.notesWritten}`,
              `tags attached: ${outcome.tagsAttached}`,
            ]),
          ),
          outcome.linksReused.length === 0
            ? null
            : section(
                "Links that already existed",
                bullet(outcome.linksReused.map((l) => `${l.from} -> ${l.to}: ${l.note}`)),
              ),
          outcome.failures.length === 0
            ? null
            : section(
                "Failed",
                bullet(outcome.failures.map((f) => `${f.what}: ${f.reason}`)) +
                  "\n\nEverything else was written. There is no rollback — retry only " +
                  "the failed parts, otherwise you risk duplicates.",
              ),
          fenceWarnings.length === 0
            ? null
            : section(
                "Warning",
                "TheBrain drops the closing ``` on save, so notes with fenced code blocks " +
                  `will be corrupted: ${fenceWarnings.join(", ")}. ` +
                  "Prefer indenting code by four spaces.",
              ),
          section(
            "Next",
            "The identifiers above work immediately. To show the result to the user, " +
              "open the root thought with brain_activate. Refresh the semantic index " +
              "with brain_index using action=sync.",
          ),
        ]),
      );
    }),
  );
}
