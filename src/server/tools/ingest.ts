/**
 * Batch write: moves a decomposed structure into the brain in one call.
 */

import { z } from "zod";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { MAX_ALIASES, warnIfFencedCode } from "../../api/index.js";
import {
  IngestReadError,
  IngestValidationError,
  ingest,
  type IngestOutcome,
} from "../../operations/ingest.js";
import type { ServerContext } from "../context.js";
import {
  bullet,
  describeError,
  fail,
  guard,
  join,
  kindMark,
  ok,
  section,
  sentence,
  table,
} from "../respond.js";
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
              note: z
                .string()
                .optional()
                .describe(
                  "Note in Markdown. Written to a new thought, and to one that existed " +
                    "only if it has no note: a note that is there is kept, and the " +
                    "result says so.",
                ),
              parent: z
                .string()
                .optional()
                .describe(
                  "A tempId from this batch or the UUID of an existing thought. " +
                    "Without it the thought is left unlinked, and a second run of the plan " +
                    "makes it again. Not a type or a tag: those go in typeId and tagIds.",
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
              "into a graph — use them freely and label them. Neither a type nor a tag can " +
              "be the parent end of a child or parent link: set a type with typeId and a " +
              "tag with tagIds.",
          ),
        deduplicate: z
          .boolean()
          .optional()
          .describe(
            "Skip creating a thought when its parent already has one of that name under " +
              "the same relation. On by default, which makes re-running a batch safe. A " +
              "thought of that name under another relation is neither reused nor made " +
              "again: it fails, with its identifier. So do two of that name under the " +
              "same relation.",
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

      // Only the notes that were written: one that was not, its thought
      // having failed or the note itself, used to be listed here as one that
      // "will be corrupted".
      const noted = new Set(outcome.notesWrittenFor);
      const fenceWarnings = thoughts
        .filter(
          (t) => noted.has(t.tempId) && t.note !== undefined && warnIfFencedCode(t.note) !== null,
        )
        .map((t) => t.name);

      // A batch that left something unwritten is an error, so that it is not
      // read as done. Its table names each thought by tempId too: the plan
      // that follows refers to what exists by identifier.
      const partial = outcome.failures.length > 0 || outcome.skipped.length > 0;
      // A thought that existed keeps the note it has, so where the plan has
      // a note for one, the table says of every note what became of it. A
      // plan that found no thought in place, or has no note for those it
      // found, has no such column and reads as it did.
      const planned = new Set(
        thoughts.filter((t) => t.note !== undefined && t.note.trim() !== "").map((t) => t.tempId),
      );
      const kept = new Map(outcome.notesKept.map((k) => [k.tempId, k.same]));
      const noteColumn = outcome.reused.some((r) => planned.has(r.tempId));
      const noteOf = (tempId: string): string => {
        if (!planned.has(tempId)) return "-";
        if (noted.has(tempId)) return "written";
        const same = kept.get(tempId);
        // Neither written nor kept: its line is under Failed.
        return same === undefined ? "not written" : same ? "kept: same text" : KEPT_ANOTHER;
      };
      // A thought the plan found in place may be a type or a tag, and is
      // marked as a read result marks one: what the plan made is ordinary.
      const row = (
        how: string,
        t: { tempId: string; thoughtId: string; name: string; kind?: number },
      ) => [
        how,
        t.name,
        t.thoughtId + (t.kind === undefined ? "" : kindMark(t.kind)),
        ...(noteColumn ? [noteOf(t.tempId)] : []),
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
            table(
              [
                "Outcome",
                "Title",
                "Identifier",
                ...(noteColumn ? ["Note"] : []),
                ...(partial ? ["tempId"] : []),
              ],
              rows,
            ),
          ),
          section(
            "Also",
            bullet([
              `links created: ${outcome.linksCreated}`,
              `notes written: ${outcome.notesWritten}`,
              ...(outcome.notesKept.length > 0
                ? [`notes kept: ${outcome.notesKept.length}`]
                : []),
              `tags attached: ${outcome.tagsAttached}`,
              ...(thoughts.some((t) => t.aliases !== undefined)
                ? [`thoughts given aliases: ${outcome.aliasesWritten}`]
                : []),
            ]),
          ),
          section("Notes kept", notesKept(outcome.notesKept)),
          outcome.linksReused.length === 0
            ? null
            : section(
                "Links that already existed",
                bullet(outcome.linksReused.map((l) => `${l.from} -> ${l.to}: ${l.note}`)),
              ),
          section(
            "Links not added",
            bullet(outcome.linksNotAdded.map((l) => `${l.from} -> ${l.to}: ${l.note}`)),
          ),
          section("Failed", bullet(outcome.failures.map((f) => `${f.what}: ${whyFailed(f)}`))),
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
          section("Listing not read", listingNotRead(outcome.listingUnread)),
          section(
            "Next",
            partial
              ? afterAFailure(
                  rows.length > 0,
                  // With no thought in the table only a thought's own line
                  // can say that one may have been written.
                  outcome.failures.some(
                    (f) => f.unanswered && (rows.length > 0 || f.of === "thought"),
                  ),
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

/**
 * What follows a batch whose last reads failed: the ones that wait for each
 * graph to list what was made next to its thought. Such a read used to count
 * as a graph that listed nothing, and the result said "TheBrain does not yet
 * list" of a graph nothing had read, and to wait a few seconds. Null when
 * every graph answered.
 *
 * It is no failure of the batch: what the plan asked for is written.
 */
function listingNotRead(unread: IngestOutcome["listingUnread"]): string | null {
  if (unread.length === 0) return null;
  const lines = unread.map(
    (u) =>
      `${u.thoughtId}, with ${u.made} of them next to it: ${sentence(describeError(u.error))}`,
  );
  return (
    "Whether TheBrain lists the new thoughts yet could not be read for the thoughts they " +
    `were attached to:\n${bullet(lines)}\n` +
    "No write failed by this. Before sending this plan again, read each of them with " +
    "brain_get_thought and see that it lists them: sent before that, the plan would make " +
    "them a second time."
  );
}

/** What the table says of a plan's note that a thought's own, different note kept out. */
const KEPT_ANOTHER = "kept: another text";

/**
 * What follows a plan's note that was not written because the thought it
 * was for has another. Null when no note was kept, and when each one kept
 * is the plan's own text, as a second run of a plan finds it: the table
 * says so, and there is nothing to do.
 *
 * It is no failure of the batch. The note is where it was, and what to do
 * with the plan's text is for the caller to say: this names the two tools,
 * and that one of them loses what the note held.
 */
function notesKept(kept: IngestOutcome["notesKept"]): string | null {
  const other = kept.filter((k) => !k.same).length;
  if (other === 0) return null;
  return (
    "A thought that existed keeps the note it has: a plan's note is written only where " +
    `there is none, never over one. ${other} of the notes kept ${other === 1 ? "is" : "are"} ` +
    `not the plan's text, marked "${KEPT_ANOTHER}" in the table, and the plan's text for ` +
    `${other === 1 ? "that thought" : "those thoughts"} was written nowhere. To add it, ` +
    "read the thought with brain_get_thought and call brain_append_note. brain_set_note " +
    "replaces a note, and what it held is lost."
  );
}

/**
 * Why a write of the batch failed, as `describeError()` explains a call's
 * own failure: the lines used to carry the API's bare words, so that its
 * catch-all 403 read as a missing key and `Could not create thought.` as
 * nothing at all. Without "Nothing was written", which is true of the write
 * that was refused and would be read of the batch.
 *
 * A write that got no answer is not a write that failed, and its line says
 * what to look at before it is sent again. So does the line of a note that
 * was not written because the thought's own could not be read: the section
 * under it names `brain_set_note` for a note that failed, and that would
 * replace the note the batch left alone.
 */
function whyFailed(failure: IngestOutcome["failures"][number]): string {
  const { error } = failure;
  if (error instanceof IngestReadError) {
    const why = `${error.context}: ${describeError(error.cause, false)}`;
    return failure.of === "note" ? `${sentence(why)} ${NOTE_UNREAD}` : why;
  }
  const why = describeError(error, false);
  return failure.unanswered ? `${sentence(why)} ${UNANSWERED[failure.of]}` : why;
}

const NOTE_UNREAD =
  "Read the thought with brain_get_thought before writing this note: where it has one, " +
  "add to it with brain_append_note.";

const CARRIED_OUT =
  "No answer came, so TheBrain may have carried it out all the same: read the thought " +
  "with brain_get_thought before sending it again.";

/** Added to a write that got no answer, by what it was to make. */
const UNANSWERED: Record<IngestOutcome["failures"][number]["of"], string> = {
  thought:
    "No answer came, so TheBrain may have created it all the same: before creating it " +
    "again, look for it next to its parent with brain_get_thought.",
  note:
    "No answer came, so TheBrain may have written it all the same: read the thought with " +
    "brain_get_thought before writing its note again.",
  tag: CARRIED_OUT,
  aliases: CARRIED_OUT,
  link: CARRIED_OUT,
};
