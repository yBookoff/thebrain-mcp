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
  normalizeAliases,
  warnIfFencedCode,
  type AliasOutcome,
} from "../../api/index.js";
import { linkFound } from "../../operations/ingest.js";
import { confirmDestructive, confirmationInstructions } from "../confirm.js";
import type { ServerContext } from "../context.js";
import { bullet, fail, guard, join, ok, section } from "../respond.js";

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

      const thoughtId = await ctx.api.thoughts.create(bid, {
        name,
        ...(parentId !== undefined ? { sourceThoughtId: parentId } : {}),
        ...(relation !== undefined ? { relation: RELATION_VALUES[relation] } : {}),
        ...(typeId !== undefined ? { typeId } : {}),
        ...(label !== undefined ? { label } : {}),
        ...(aliases.length > 0 ? { aliases } : {}),
      });

      const done: string[] = [`created thought "${name}" — ${thoughtId}`];
      if (aliases.length > 0) done.push(`aliases: ${JSON.stringify(aliases)}`);
      const warnings: string[] = [];

      if (note !== undefined && note.trim() !== "") {
        await ctx.api.notes.set(bid, thoughtId, note);
        done.push("note written");
        const warning = warnIfFencedCode(note);
        if (warning !== null) warnings.push(warning);
      }

      for (const tagId of tagIds ?? []) {
        await ctx.api.links.attachTag(bid, thoughtId, tagId);
      }
      if ((tagIds ?? []).length > 0) done.push(`tags attached: ${tagIds!.length}`);

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
      await ctx.api.thoughts.update(bid, thoughtId, changes);
      const done = provided.map(([k, v]) => `${k} = ${JSON.stringify(v)}`);
      if (editsAliases) {
        done.push(
          ...describeAliasOutcome(
            await ctx.api.thoughts.changeAliases(bid, thoughtId, {
              add: addAliases,
              remove: removeAliases,
            }),
          ),
        );
      }
      return ok(section("Done", bullet(done))!);
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
      const previous = await ctx.api.notes.get(bid, thoughtId).catch(() => "");
      await ctx.api.notes.set(bid, thoughtId, markdown);
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
      await ctx.api.notes.append(bid, thoughtId, markdown);
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
      const done: string[] = [];
      for (const tagId of add ?? []) {
        await ctx.api.links.attachTag(bid, thoughtId, tagId);
        done.push(`attached ${tagId}`);
      }
      for (const tagId of remove ?? []) {
        const removed = await ctx.api.links.detachTag(bid, thoughtId, tagId);
        done.push(removed ? `removed ${tagId}` : `tag ${tagId} was not on the thought`);
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
      const note = await ctx.api.notes.get(bid, thoughtId).catch(() => "");
      const summary = join([
        `Delete the thought "${graph.thought.name ?? "(unnamed)"}"?`,
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
      ctx.store(bid).remove([thoughtId]);
      return ok(
        section("Deleted", `"${graph.thought.name ?? "(unnamed)"}" is gone from the brain`)!,
      );
    }),
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
