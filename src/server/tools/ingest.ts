/**
 * Batch write: moves a decomposed structure into the brain in one call.
 */

import { z } from "zod";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { MAX_ALIASES, warnIfFencedCode } from "../../api/index.js";
import { IngestValidationError, ingest } from "../../operations/ingest.js";
import type { ServerContext } from "../context.js";
import { bullet, fail, guard, join, ok, section, table } from "../respond.js";
import { ALIAS_COST } from "./write.js";

const relation = z
  .enum(["child", "parent", "jump"])
  .describe("How this thought relates to its parent. Usually child. Refused without a parent.");

export function registerIngestTool(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "brain_ingest",
    {
      description:
        "Writes a whole structure of thoughts, links, notes, tags and aliases in a single call. " +
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
                    "Without it the thought is left unlinked, and a second run of the plan " +
                    "makes it again. Not a type: that goes in typeId.",
                ),
              relation: relation.optional(),
              typeId: z.string().optional().describe("Type from brain_list_types_and_tags."),
              tagIds: z
                .array(z.string())
                .optional()
                .describe("Tag identifiers from brain_list_types_and_tags, not tempIds."),
              label: z.string().optional(),
              aliases: z
                .array(z.string())
                .max(MAX_ALIASES)
                .optional()
                .describe(
                  "Alternate names. A thought that already existed keeps its own and " +
                    `gains these. ${ALIAS_COST}`,
                ),
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
              "into a graph — use them freely and label them. A type cannot be the parent " +
              "end of a child or parent link: set a type with typeId.",
          ),
        deduplicate: z
          .boolean()
          .optional()
          .describe(
            "Skip creating a thought when its parent already has one of that name under " +
              "the same relation. On by default, which makes re-running a batch safe. A " +
              "thought of that name under another relation is neither reused nor made " +
              "again: it fails, with its identifier.",
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

      // A batch that left something unwritten is an error, so that it is not
      // read as done. Its table names each thought by tempId too: the plan
      // that follows refers to what exists by identifier.
      const partial = outcome.failures.length > 0 || outcome.skipped.length > 0;
      const row = (how: string, t: { tempId: string; thoughtId: string; name: string }) => [
        how,
        t.name,
        t.thoughtId,
        ...(partial ? [t.tempId] : []),
      ];
      const rows = [
        ...outcome.created.map((c) => row("created", c)),
        ...outcome.reused.map((r) => row("existed", r)),
      ];

      return (partial ? fail : ok)(
        join([
          section(
            "Thoughts",
            table(["Outcome", "Title", "Identifier", ...(partial ? ["tempId"] : [])], rows),
          ),
          section(
            "Also",
            bullet([
              `links created: ${outcome.linksCreated}`,
              `notes written: ${outcome.notesWritten}`,
              `tags attached: ${outcome.tagsAttached}`,
              ...(thoughts.some((t) => t.aliases !== undefined)
                ? [`thoughts given aliases: ${outcome.aliasesWritten}`]
                : []),
            ]),
          ),
          outcome.linksReused.length === 0
            ? null
            : section(
                "Links that already existed",
                bullet(outcome.linksReused.map((l) => `${l.from} -> ${l.to}: ${l.note}`)),
              ),
          section(
            "Failed",
            bullet(
              outcome.failures.map(
                (f) => `${f.what}: ${f.reason}${f.unanswered ? UNANSWERED : ""}`,
              ),
            ),
          ),
          section("Skipped", bullet(outcome.skipped.map((s) => `${s.what}: ${s.reason}`))),
          fenceWarnings.length === 0
            ? null
            : section(
                "Warning",
                "TheBrain drops the closing ``` on save, so notes with fenced code blocks " +
                  `will be corrupted: ${fenceWarnings.join(", ")}. ` +
                  "Prefer indenting code by four spaces.",
              ),
          outcome.unlisted === 0
            ? null
            : section(
                "Not listed yet",
                `TheBrain does not yet list ${outcome.unlisted} of the new thoughts next to ` +
                  "the thoughts they were attached to. This plan sent again now would not " +
                  "find them and would make them a second time: wait a few seconds first.",
              ),
          section(
            "Next",
            partial
              ? afterAFailure(
                  rows.length > 0,
                  outcome.failures.some((f) => f.unanswered),
                )
              : "The identifiers above work immediately. To show the result to the user, " +
                  "open the root thought with brain_activate. Refresh the semantic index " +
                  "with brain_index using action=sync.",
          ),
        ]),
      );
    }),
  );
}

/**
 * What follows a batch written in part. It asks for the rest alone: a whole
 * plan sent again finds a thought only next to its parent, and makes one
 * that has no parent a second time, with everything under it. With no
 * thought written there is nothing to make twice, and the plan is what to
 * send.
 */
function afterAFailure(anyThought: boolean, unanswered: boolean): string {
  if (!anyThought) {
    return (
      "None of the plan's thoughts was written" +
      (unanswered ? ", unless a line under Failed says one may have been" : "") +
      ", and nothing is rolled back. Fix the cause and send the plan again."
    );
  }
  return (
    "The batch was written in part, and nothing is rolled back. The thoughts in the " +
    "table exist, and their identifiers work immediately. What is under Failed and " +
    "Skipped was not written, a listed thought's note, tags and aliases included" +
    (unanswered ? ", unless its line says it may have been. " : ". ") +
    "Fix the cause and write only that: thoughts and links in a new plan, naming " +
    "each thought of the table by its identifier in place of its tempId; a note, tag " +
    "or alias of a thought in the table with brain_set_note, brain_tag or " +
    "brain_update_thought. Do not send the whole plan again: a thought it made with " +
    "no parent would be made twice."
  );
}

/** Added to a create that got no answer, which is not a create that failed. */
const UNANSWERED =
  " — no answer came, so TheBrain may have created it all the same: before creating " +
  "it again, look for it next to its parent with brain_get_thought";
