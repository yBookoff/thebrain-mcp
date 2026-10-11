/**
 * Write tools.
 *
 * No JSON Patch is exposed: tools take flat fields. Deletion requires human
 * confirmation and only works when it has been enabled by configuration.
 */

import { z } from "zod";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { Relation, ThoughtKind } from "../../api/types.js";
import {
  MAX_ALIASES,
  TheBrainError,
  mayHaveLanded,
  normalizeAliases,
  warnIfFencedCode,
  type AliasOutcome,
  type ApiErrorKind,
  type UpdateThoughtInput,
} from "../../api/index.js";
import { linkFound } from "../../operations/ingest.js";
import { confirmDestructive, confirmationInstructions } from "../confirm.js";
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
  type ToolResponse,
} from "../respond.js";

const brainId = z
  .string()
  .describe("Brain identifier. Take it from brain_list — never guess it.");

/**
 * What the first alias costs, in the words of TheBrain's own spec. It goes on
 * every argument that can write one: the choice belongs to the user, and an
 * agent can only put it to them if it knows.
 */
export const ALIAS_COST =
  "Saving a brain's first alias makes that brain require TheBrain 15.0.621 or " +
  "later on every device, so write aliases only when the user wants them in this brain.";

const RELATION_VALUES = {
  child: Relation.Child,
  parent: Relation.Parent,
  jump: Relation.Jump,
} as const;

export function registerWriteTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "brain_create_thought",
    {
      description:
        "Creates a thought and sets its note, type, tags and aliases in the same call. " +
        "Call it when adding something new. Always supply parentId — a thought with " +
        "no links gets lost in the graph. Search first: a suitable thought may already " +
        "exist, in which case extending it is the better move.",
      inputSchema: {
        brainId,
        name: z.string().min(1).describe("Thought title. Short and to the point."),
        parentId: z
          .string()
          .optional()
          .describe(
            "What to attach it to. Without this the thought is left orphaned. " +
              "Not a type: a thought made under one would get that type and no parent, " +
              "so a type goes in typeId. Not a tag either: that goes in tagIds.",
          ),
        relation: z
          .enum(["child", "parent", "jump"])
          .optional()
          .describe(
            "How the new thought relates to that one. Child by default. For a sibling " +
              "of a thought, give that thought's parent as parentId. Refused without parentId.",
          ),
        note: z.string().optional().describe("Note body in Markdown."),
        typeId: z
          .string()
          .optional()
          .describe("Type identifier from brain_list_types_and_tags."),
        tagIds: z
          .array(z.string())
          .optional()
          .describe("Tag identifiers from brain_list_types_and_tags."),
        label: z.string().optional().describe("Short caption under the title."),
        aliases: z
          .array(z.string())
          .max(MAX_ALIASES)
          .optional()
          .describe(`Alternate names that TheBrain's search matches too. ${ALIAS_COST}`),
      },
    },
    guard(async (args) => {
      const { brainId: bid, name, parentId, relation, note, typeId, tagIds, label } = args;
      const aliases = normalizeAliases(args.aliases ?? []);

      // Refused, not left out: the thought used to be created with no link
      // and reported as created. `create` refuses it too, in its own terms.
      if (relation !== undefined && parentId === undefined) {
        return fail(
          `relation "${relation}" says how the new thought is linked to parentId, and no ` +
            "parentId was given. Nothing was created. Pass parentId, or leave relation " +
            "out to create a thought with no link.",
        );
      }

      // Before the thought exists: refused after it, a tag that is no tag
      // would leave the thought behind for a retry to make again.
      for (const tagId of tagIds ?? []) await ctx.api.links.requireTag(bid, tagId);
      // A type for a parent is no parent: the thought would be one of that
      // type. Nor is a tag: the thought would be tagged, and have no parent.
      // `create` refuses both too, under the name the API has for the argument.
      if (parentId !== undefined && (relation ?? "child") === "child") {
        await ctx.api.links.requireParent(bid, parentId, "parentId");
      }

      const hasNote = note !== undefined && note.trim() !== "";
      const tags = tagIds ?? [];
      let thoughtId: string;
      try {
        thoughtId = await ctx.api.thoughts.create(bid, {
          name,
          ...(parentId !== undefined ? { sourceThoughtId: parentId } : {}),
          ...(relation !== undefined ? { relation: RELATION_VALUES[relation] } : {}),
          ...(typeId !== undefined ? { typeId } : {}),
          ...(label !== undefined ? { label } : {}),
          ...(aliases.length > 0 ? { aliases } : {}),
        });
      } catch (error) {
        // A create with no answer is not a create that failed: the thought
        // may be there, and the same call sent again would make a second.
        if (!mayHaveLanded(error)) throw error;
        return fail(
          join([
            describeError(error),
            section("Next", afterNoAnswer(name, parentId, hasNote, tags.length > 0)),
          ]),
        );
      }

      const done: string[] = [`created thought "${name}" — ${thoughtId}`];
      if (aliases.length > 0) done.push(`aliases: ${JSON.stringify(aliases)}`);
      const warnings: string[] = [];

      // The thought exists from here on, and nothing below may lose its
      // identifier: a note or a tag that failed used to throw, the result was
      // the error alone, and the call sent again made a second thought.
      const steps: Step[] = [];
      if (hasNote) {
        steps.push({
          what: "note",
          run: async () => {
            await ctx.api.notes.set(bid, thoughtId, note);
            const warning = warnIfFencedCode(note);
            if (warning !== null) warnings.push(warning);
            return ["note written"];
          },
        });
      }
      for (const tagId of tags) {
        steps.push({
          what: `tag ${tagId}`,
          run: async () => {
            await ctx.api.links.attachTag(bid, thoughtId, tagId);
            return [`tag attached: ${tagId}`];
          },
        });
      }
      const { done: written, stopped } = await inOrder(steps);
      if (stopped !== null) {
        // The note is the first step, so it is left over only when it is
        // what failed; the tags come last, so any failure leaves one.
        const rest = [
          ...(stopped.what === "note" ? ["the note with brain_set_note"] : []),
          ...(tags.length > 0 ? ["tags with brain_tag"] : []),
        ];
        return writtenInPart(
          [...done, ...written],
          stopped,
          "The thought exists, and its identifier works immediately: do not create it " +
            `again. Fix the cause and write only the rest to ${thoughtId}: ${rest.join(", ")}.`,
          warnings,
        );
      }
      if (hasNote) done.push("note written");
      if (tags.length > 0) done.push(`tags attached: ${tags.length}`);

      return ok(
        join([
          section("Done", bullet(done)),
          warnings.length > 0 ? section("Warning", bullet(warnings)) : null,
          section(
            "Next",
            "The identifier above works immediately. Searching for this thought by " +
              "name only succeeds after a few seconds, so refer to it by identifier.",
          ),
        ]),
      );
    }),
  );

  server.registerTool(
    "brain_update_thought",
    {
      description:
        "Changes a thought's properties: title, caption, aliases, type, colours. " +
        "Call it to rename or reclassify. It does not touch the note — " +
        "use brain_set_note or brain_append_note for that.",
      inputSchema: {
        brainId,
        thoughtId: z.string().describe("Which thought to change."),
        name: z.string().optional().describe("New title."),
        label: z.string().nullable().optional().describe("Caption; null clears it."),
        typeId: z
          .string()
          .nullable()
          .optional()
          .describe("Type identifier from brain_list_types_and_tags; null removes the type."),
        foregroundColor: z
          .string()
          .nullable()
          .optional()
          .describe("Text colour, for example #ff7145; null clears it."),
        backgroundColor: z
          .string()
          .nullable()
          .optional()
          .describe("Background colour; null clears it."),
        addAliases: z
          .array(z.string())
          .max(MAX_ALIASES)
          .optional()
          .describe(
            "Alternate names to add to the ones the thought has; TheBrain's search " +
              `matches them too. ${ALIAS_COST}`,
          ),
        removeAliases: z
          .array(z.string())
          .optional()
          .describe("Aliases to drop, matched ignoring case."),
      },
    },
    guard(async ({ brainId: bid, thoughtId, addAliases, removeAliases, ...changes }) => {
      const provided = Object.entries(changes).filter(([, v]) => v !== undefined);
      const editsAliases = (addAliases ?? []).length > 0 || (removeAliases ?? []).length > 0;
      if (provided.length === 0 && !editsAliases) {
        return fail("no fields were supplied to change");
      }
      const line = ([k, v]: readonly [string, unknown]): string => `${k} = ${JSON.stringify(v)}`;
      // One field to a request. The API applies a patch one operation at a
      // time and keeps what it wrote before the one it refuses, without
      // saying which that was: with a colour it refused, a name sent in the
      // same patch was changed, and the result was the error alone. A field
      // sent alone is written or it is not.
      //
      // The type goes first. What refuses a typeId refuses it ahead of the
      // write, and that has to be ahead of every write of the call.
      const typeFirst = [
        ...provided.filter(([key]) => key === "typeId"),
        ...provided.filter(([key]) => key !== "typeId"),
      ];
      const steps: Step[] = typeFirst.map((field) => ({
        what: line(field),
        run: async () => {
          const change = { [field[0]]: field[1] } as UpdateThoughtInput;
          await ctx.api.thoughts.update(bid, thoughtId, change);
          return [line(field)];
        },
      }));
      let aliasLines: string[] = [];
      if (editsAliases) {
        steps.push({
          what: "aliases",
          run: async () => {
            // With the name this call has just written: the read behind an
            // alias edit still returns the old one, and the old name kept as
            // an alias was dropped as equal to the name.
            aliasLines = describeAliasOutcome(
              await ctx.api.thoughts.changeAliases(
                bid,
                thoughtId,
                { add: addAliases, remove: removeAliases },
                { name: changes.name },
              ),
            );
            return aliasLines;
          },
        });
      }
      const { done, stopped } = await inOrder(steps);
      if (stopped !== null) {
        if (wasAll(done, stopped)) throw stopped.error;
        return writtenInPart(
          done,
          stopped,
          `Fix the cause and send only the rest, in a brain_update_thought call for ${thoughtId}.`,
        );
      }
      return ok(section("Done", bullet([...provided.map(line), ...aliasLines]))!);
    }),
  );

  server.registerTool(
    "brain_set_note",
    {
      description:
        "Replaces a thought's note entirely. The previous text is lost — " +
        "to add rather than replace, call brain_append_note. " +
        "Read an existing note with brain_get_thought before overwriting it.",
      inputSchema: {
        brainId,
        thoughtId: z.string(),
        markdown: z.string().describe("The complete new note body, in Markdown."),
      },
    },
    guard(async ({ brainId: bid, thoughtId, markdown }) => {
      // Read, and not written over when the read fails. The failure used to
      // be dropped: the note was replaced, and the result said "note
      // created" of a note it had not seen. A thought with no note is a 200
      // from this read, so a failure is never that answer.
      let previous: string;
      try {
        previous = await ctx.api.notes.get(bid, thoughtId);
      } catch (error) {
        if (aboutTheCall(error)) throw error;
        return fail(
          "The note was not replaced, and nothing was written. The note this thought has " +
            "now could not be read, so what a replacement would erase is not known: " +
            `${sentence(describeError(error))} Read it with brain_get_thought, then send ` +
            "this call again.",
        );
      }
      try {
        await ctx.api.notes.set(bid, thoughtId, markdown);
      } catch (error) {
        // A write with no answer is not a write that failed: the note may
        // hold the new text, and what it held before is known here alone.
        if (!mayHaveLanded(error)) throw error;
        const before =
          previous.trim() === ""
            ? "The thought had no note before the call."
            : `Before the call the note held ${previous.length} characters, and they are gone if it did.`;
        return fail(
          join([
            describeError(error),
            section(
              "Next",
              "No answer came to the write, so TheBrain may have replaced the note all the " +
                `same. ${before} Read the thought with brain_get_thought to see which text ` +
                "it has. Sent again, this call writes the same text.",
            ),
          ]),
        );
      }
      const warning = warnIfFencedCode(markdown);
      return ok(
        join([
          section(
            "Done",
            previous.trim() === ""
              ? "note created"
              : `note replaced; the previous text (${previous.length} characters) is gone`,
          ),
          warning === null ? null : section("Warning", warning),
        ]),
      );
    }),
  );

  server.registerTool(
    "brain_append_note",
    {
      description:
        "Appends text to the end of a note without erasing anything. " +
        "The main way to accumulate material on a thought. " +
        "If no note exists yet, one is created.",
      inputSchema: {
        brainId,
        thoughtId: z.string(),
        markdown: z.string().describe("What to append, in Markdown."),
      },
    },
    guard(async ({ brainId: bid, thoughtId, markdown }) => {
      try {
        await ctx.api.notes.append(bid, thoughtId, markdown);
      } catch (error) {
        // `append` reads the note and then writes once, and the two fail
        // apart. Both used to be the request's error alone, and after a
        // timeout that left the model to guess which it was.
        if (mayHaveLanded(error)) {
          // The one write whose repeat is not the same write: appended again
          // after an append that went through, the text is in the note twice.
          return fail(
            join([
              describeError(error),
              section(
                "Next",
                "No answer came to the write, so TheBrain may have appended the text all " +
                  "the same. Read the note with brain_get_thought before sending this call " +
                  "again: sent again after an append that went through, the text would be " +
                  "in the note twice.",
              ),
            ]),
          );
        }
        // The read is the one GET of the call. Any other failure is the
        // write's own answer, or the call's, and is passed on as it was.
        const atTheRead = error instanceof TheBrainError && error.method === "GET";
        if (!atTheRead || aboutTheCall(error)) throw error;
        return fail(
          "Nothing was appended. The note is read before it is added to, and that read " +
            `failed: ${sentence(describeError(error))} This call can be sent again as it is.`,
        );
      }
      const warning = warnIfFencedCode(markdown);
      return ok(
        join([
          section("Done", "text appended to the note"),
          warning === null ? null : section("Warning", warning),
        ]),
      );
    }),
  );

  server.registerTool(
    "brain_link",
    {
      description:
        "Links two thoughts. Call it when you spot a meaningful relationship between " +
        "existing thoughts — links are what make a brain a graph rather than a list. " +
        'Label the link via name: "motivates", "solved by", "contradicts". ' +
        "Two thoughts share one link: where one joins them already nothing is added, " +
        "and the result says what is there.",
      inputSchema: {
        brainId,
        fromId: z.string().describe("Source thought."),
        toId: z.string().describe("Target thought."),
        relation: z
          .enum(["child", "parent", "jump"])
          .optional()
          .describe(
            "How the target relates to the source. Defaults to jump — a sideways link " +
              "that leaves the hierarchy alone. Siblings are not linked to each other: " +
              "they are thoughts with a parent in common. A type cannot be the parent: " +
              "that link would set the child's type, which is what typeId of " +
              "brain_update_thought is for. Nor can a tag: that link would tag the child, " +
              "which is what brain_tag is for.",
          ),
        name: z.string().optional().describe("Link label: how exactly one relates to the other."),
      },
    },
    guard(async ({ brainId: bid, fromId, toId, relation, name }) => {
      // Ahead of everything, the label of a link already there included: under
      // a type a thought is given that type, and loses the one it had, and
      // under a tag it is tagged, which is no link and no parent.
      if (relation === "child") await ctx.api.links.requireParent(bid, fromId, "fromId");
      if (relation === "parent") await ctx.api.links.requireParent(bid, toId, "toId");
      const existing = await ctx.api.links.between(bid, fromId, toId);
      if (existing !== null) {
        // It used to answer "Link already existed" whatever joined the two,
        // and to write the label onto a tag's attachment or a type's link.
        const found = linkFound(
          existing,
          {
            from: fromId,
            to: toId,
            relation: relation ?? "jump",
            fromName: "fromId",
            toName: "toId",
          },
          name !== undefined,
        );
        if (!found.ordinary) return ok(section("No link added", found.note)!);
        if (name !== undefined) await ctx.api.links.update(bid, existing.id, { name });
        return ok(
          section(
            "Link already existed",
            found.asAsked
              ? `identifier ${existing.id}` + (name !== undefined ? ", label updated" : "")
              : `identifier ${existing.id}: ${found.note}`,
          )!,
        );
      }
      const linkId = await ctx.api.links.create(bid, {
        thoughtIdA: fromId,
        thoughtIdB: toId,
        relation: RELATION_VALUES[relation ?? "jump"],
        ...(name !== undefined ? { name } : {}),
      });
      return ok(section("Done", `link created — ${linkId}`)!);
    }),
  );

  server.registerTool(
    "brain_tag",
    {
      description:
        "Attaches and removes a thought's tags. Tags are separate thoughts of a special " +
        "kind; take their identifiers from brain_list_types_and_tags, and create a new tag " +
        "via brain_create_thought. A single call can both add and remove.",
      inputSchema: {
        brainId,
        thoughtId: z.string(),
        add: z.array(z.string()).optional().describe("Tag identifiers to attach."),
        remove: z.array(z.string()).optional().describe("Tag identifiers to remove."),
      },
    },
    guard(async ({ brainId: bid, thoughtId, add, remove }) => {
      if ((add ?? []).length === 0 && (remove ?? []).length === 0) {
        return fail("no tags were given to add or remove");
      }
      // All of them before the first write: one that is no tag must not leave
      // the tags ahead of it attached or removed.
      for (const tagId of [...(add ?? []), ...(remove ?? [])]) {
        await ctx.api.links.requireTag(bid, tagId, thoughtId);
      }
      // "Was not on the thought" is an answer about a thought that is there.
      // The lookup behind a removal is a 404 for a thought nobody has as for
      // a tag that is not on one, and the first used to get that answer too.
      // So the thought is read before it is given, once a call: a removal
      // that finds its tag costs nothing more.
      let read: Promise<unknown> | undefined;
      const thoughtIsThere = (): Promise<unknown> =>
        (read ??= ctx.api.thoughts.get(bid, thoughtId));
      const steps: Step[] = [
        ...(add ?? []).map((tagId) => ({
          what: `attach ${tagId}`,
          run: async () => {
            await ctx.api.links.attachTag(bid, thoughtId, tagId);
            return [`attached ${tagId}`];
          },
        })),
        ...(remove ?? []).map((tagId) => ({
          what: `remove ${tagId}`,
          run: async () => {
            if (await ctx.api.links.detachTag(bid, thoughtId, tagId)) return [`removed ${tagId}`];
            await thoughtIsThere();
            return [`tag ${tagId} was not on the thought`];
          },
        })),
      ];
      const { done, stopped } = await inOrder(steps);
      if (stopped !== null) {
        if (wasAll(done, stopped)) throw stopped.error;
        return writtenInPart(
          done,
          stopped,
          `Fix the cause and send only the rest, in a brain_tag call for ${thoughtId}.`,
        );
      }
      return ok(
        join([
          section("Done", bullet(done)),
          section(
            "Note",
            "Tag changes are not visible in the graph immediately — up to half a second. " +
              "Re-reading the thought right away may still show the old tags.",
          ),
        ]),
      );
    }),
  );

  server.registerTool(
    "brain_attach_url",
    {
      description:
        "Attaches a link to a thought. Checks first whether the same URL is already " +
        "attached and avoids duplicates. Leave name empty to take the title from the page.",
      inputSchema: {
        brainId,
        thoughtId: z.string(),
        url: z.string().url().describe("Page address."),
        name: z.string().optional().describe("Attachment name; empty means use the page title."),
      },
    },
    guard(async ({ brainId: bid, thoughtId, url, name }) => {
      const result = await ctx.api.attachments.attachUrl(bid, thoughtId, url, {
        ...(name !== undefined ? { name } : {}),
      });
      return ok(
        result.created
          ? section("Done", `link attached: ${url}`)!
          : section(
              "Already there",
              `this URL is already attached as "${result.existing?.name ?? "unnamed"}" — nothing changed`,
            )!,
      );
    }),
  );

  server.registerTool(
    "brain_activate",
    {
      description:
        "Opens a thought in the user's TheBrain app on screen. " +
        "Call it to show the person a result — for instance a structure you have just " +
        "created, so they can see it in the graph.",
      inputSchema: { brainId, thoughtId: z.string() },
    },
    guard(async ({ brainId: bid, thoughtId }) => {
      await ctx.api.app.activateThought(bid, thoughtId);
      return ok(section("Done", "thought opened in the app")!);
    }),
  );

  server.registerTool(
    "brain_delete_thought",
    {
      description:
        "Permanently deletes a thought along with its note and links. There is no undo. " +
        "Requires human confirmation. Do not call it to tidy up on your own initiative — " +
        "only when the user explicitly asked for a deletion.",
      inputSchema: {
        brainId,
        thoughtId: z.string(),
        confirm: z
          .boolean()
          .optional()
          .describe(
            "Set to true only after a human has confirmed the deletion. " +
              "Do not decide this on their behalf.",
          ),
      },
    },
    guard(async ({ brainId: bid, thoughtId, confirm }) => {
      if (!ctx.config.allowDestructive) {
        return fail(
          "deletion is disabled. To allow it, start the server with " +
            "THEBRAIN_ALLOW_DESTRUCTIVE=1 — that is a deliberate choice by the user, " +
            "not something to work around.",
        );
      }

      const graph = await ctx.api.thoughts.getGraph(bid, thoughtId);
      // No question is put without it. The failure used to be dropped, and
      // the person was asked about a thought with no note line: consent to
      // that is not consent to losing a note.
      let note: string;
      try {
        note = await ctx.api.notes.get(bid, thoughtId);
      } catch (error) {
        if (aboutTheCall(error)) throw error;
        return fail(
          "Nothing was deleted. The thought's note could not be read, so the question for " +
            "the person could not say whether a note goes with it: " +
            `${sentence(describeError(error))} Call brain_delete_thought again.`,
        );
      }
      // Marked when it is a type or a tag, as a read result marks one: that
      // is not one thought's own, and the person asked should see which it is.
      const named = `"${graph.thought.name ?? "(unnamed)"}"${kindMark(graph.thought.kind)}`;
      const summary = join([
        `Delete the thought ${named}?`,
        bullet(
          [
            `links: ${graph.links.length}`,
            `children: ${graph.children.length}`,
            note.trim() === "" ? null : `note: ${note.length} characters`,
            graph.attachments.length > 0 ? `attachments: ${graph.attachments.length}` : null,
          ].filter((s): s is string => s !== null),
        ),
        "This cannot be undone.",
      ]);

      const outcome = await confirmDestructive(server, summary, confirm === true);
      if (!outcome.granted) {
        return fail(confirmationInstructions(summary, outcome.reason));
      }

      await ctx.api.thoughts.delete(bid, thoughtId);
      const gone = `${named} is gone from the brain`;
      try {
        ctx.store(bid).remove([thoughtId]);
      } catch (error) {
        // The thought is deleted whatever became of the index. Thrown, this
        // used to be the whole result, and read as a deletion that failed.
        return writtenInPart(
          [gone],
          { what: "its entry in the semantic index", error, skipped: [] },
          "The thought is deleted, and is not to be deleted again. Its entry stays in " +
            "the semantic index until brain_index is run with action=sync.",
        );
      }
      return ok(section("Deleted", gone)!);
    }),
  );
}

/** One write of a call that makes several, one after another. */
interface Step {
  /** What it writes, as "Failed" and "Skipped" name it. */
  what: string;
  /** Writes it, and resolves to the lines "Done" has for it. */
  run: () => Promise<string[]>;
}

/** The step a call stopped at, why, and the steps after it, which were not tried. */
interface Stopped {
  what: string;
  error: unknown;
  skipped: string[];
}

/**
 * Runs the steps in order and stops at the first that fails.
 *
 * A batch goes on past a failure (`ingest`), and a call about one thought
 * does not. A batch's writes are in flight together, and what it leaves for
 * a second call can be made twice. Here the writes follow one another, and
 * with the thought's identifier in the result each of them can be sent again
 * without making anything twice. What fails after a write that went through
 * is most often the connection, and every further try could wait out the
 * timeout with the identifier still untold.
 */
async function inOrder(steps: readonly Step[]): Promise<{ done: string[]; stopped: Stopped | null }> {
  const done: string[] = [];
  for (const [i, step] of steps.entries()) {
    try {
      done.push(...(await step.run()));
    } catch (error) {
      const skipped = steps.slice(i + 1).map((s) => s.what);
      return { done, stopped: { what: step.what, error, skipped } };
    }
  }
  return { done, stopped: null };
}

/**
 * Whether the step that failed was all the call had to do: nothing done
 * before it, nothing left after it. Then the error is the whole of the
 * result, and reads as it did.
 *
 * Not so the first of several. Its error alone says nothing of the rest, and
 * the rest was not sent: a type that was accepted and did not read back used
 * to have the other fields in the same patch, and now stops the call ahead
 * of them.
 */
function wasAll(done: readonly string[], stopped: Stopped): boolean {
  return done.length === 0 && stopped.skipped.length === 0;
}

/**
 * The result of a call that stopped part way. It is an error, so that it is
 * not read as done, and it is not the error alone, which used to be read as
 * nothing done: `brain_create_thought` lost the identifier of the thought it
 * had made, and the call sent again made a second.
 *
 * The sections are `brain_ingest`'s: what was done, by identifier; what
 * failed and why; what was not tried; what to call for the rest. `next` is
 * the tool's own last sentences.
 *
 * "Failed" is hedged, always. A step can fail after its write went through:
 * a type that was accepted and did not read back, a write that got no
 * answer. Its line says so, and the sentence under "Next" defers to it.
 */
function writtenInPart(
  done: readonly string[],
  stopped: Stopped,
  next: string,
  warnings: readonly string[] = [],
): ToolResponse {
  // "Nothing was written" is the refusal's own sentence, and true of the
  // call only while nothing stands under "Done".
  const reason = describeError(stopped.error, done.length === 0);
  return fail(
    join([
      section("Done", bullet(done)),
      section(
        "Failed",
        bullet([`${stopped.what}: ${reason}${mayHaveLanded(stopped.error) ? UNANSWERED : ""}`]),
      ),
      section("Skipped", bullet(stopped.skipped)),
      warnings.length > 0 ? section("Warning", bullet(warnings)) : null,
      section(
        "Next",
        "The call stopped at its first failure, and nothing is rolled back. " +
          (done.length > 0 ? "What is under Done was done. " : "") +
          "What is under Failed was not, unless its line says otherwise" +
          (stopped.skipped.length > 0 ? ", and what is under Skipped was not tried. " : ". ") +
          next,
      ),
    ]),
  );
}

/** Added to a write that got no answer, which is not a write that failed. */
const UNANSWERED = " — no answer came, so TheBrain may have carried it out all the same";

/**
 * Failures that are about the call and not about the request that met them:
 * an identifier that is malformed, a `brainId` that is no brain, a key
 * TheBrain rejects. The next request of the call would be refused in the
 * same words, so each is passed on as it always was.
 */
const ABOUT_THE_CALL: readonly ApiErrorKind[] = ["invalid_uuid", "unknown_brain", "auth"];

function aboutTheCall(error: unknown): boolean {
  return error instanceof TheBrainError && ABOUT_THE_CALL.includes(error.kind);
}

/**
 * What follows a create that got no answer. The thought may be there with no
 * identifier to give, so this says where to look before it is created again:
 * next to its parent, or, for a thought created with none, by name. The
 * index knows a new thought only after a sync, and a search that missed it
 * for that reason would be read as "not there".
 */
function afterNoAnswer(
  name: string,
  parentId: string | undefined,
  hasNote: boolean,
  hasTags: boolean,
): string {
  const rest = [
    ...(hasNote ? ["its note with brain_set_note"] : []),
    ...(hasTags ? ["its tags with brain_tag"] : []),
  ];
  return (
    `No answer came to the create, so TheBrain may have made "${name}" all the same, ` +
    "and there is no identifier to give for it. Before creating it again, look for it " +
    (parentId !== undefined
      ? `next to ${parentId} with brain_get_thought.`
      : "with brain_search, after brain_index with action=sync where the brain has an " +
        "index: with no parent it is next to no thought, and TheBrain's own search " +
        "finds a new thought only after some seconds.") +
    (rest.length > 0
      ? ` Nothing else of the call was written: if the thought is there, write ${rest.join(" and ")}.`
      : "")
  );
}

/** What an alias edit did, including the case where it had nothing to do. */
export function describeAliasOutcome(outcome: AliasOutcome): string[] {
  const lines: string[] = [];
  if (outcome.added.length > 0) lines.push(`aliases added: ${JSON.stringify(outcome.added)}`);
  if (outcome.removed.length > 0) {
    lines.push(`aliases removed: ${JSON.stringify(outcome.removed)}`);
  }
  if (lines.length === 0) {
    lines.push("aliases unchanged: nothing new to add, nothing found to remove");
  }
  lines.push(`aliases now: ${JSON.stringify(outcome.aliases)}`);
  if (!outcome.readBack) {
    lines.push(
      "the new aliases are written but do not read back yet: check them with " +
        "brain_get_thought before editing this thought's aliases again, or the edit will undo them",
    );
  }
  return lines;
}

export { ThoughtKind };
