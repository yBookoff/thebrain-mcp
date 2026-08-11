/**
 * Write tools.
 *
 * No JSON Patch is exposed: tools take flat fields. Deletion requires human
 * confirmation and only works when it has been enabled by configuration.
 */

import { z } from "zod";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { Relation, ThoughtKind } from "../../api/types.js";
import { warnIfFencedCode } from "../../api/index.js";
import { confirmDestructive, confirmationInstructions } from "../confirm.js";
import type { ServerContext } from "../context.js";
import { bullet, fail, guard, join, ok, section } from "../respond.js";

const brainId = z
  .string()
  .describe("Brain identifier. Take it from brain_list — never guess it.");

const RELATION_VALUES = {
  child: Relation.Child,
  parent: Relation.Parent,
  jump: Relation.Jump,
  sibling: Relation.Sibling,
} as const;

export function registerWriteTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "brain_create_thought",
    {
      description:
        "Creates a thought and sets its note, type and tags in the same call. " +
        "Call it when adding something new. Always supply parentId — a thought with " +
        "no links gets lost in the graph. Search first: a suitable thought may already " +
        "exist, in which case extending it is the better move.",
      inputSchema: {
        brainId,
        name: z.string().min(1).describe("Thought title. Short and to the point."),
        parentId: z
          .string()
          .optional()
          .describe("What to attach it to. Without this the thought is left orphaned."),
        relation: z
          .enum(["child", "parent", "jump", "sibling"])
          .optional()
          .describe("How the new thought relates to that one. Child by default."),
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
      },
    },
    guard(async (args) => {
      const { brainId: bid, name, parentId, relation, note, typeId, tagIds, label } = args;

      const thoughtId = await ctx.api.thoughts.create(bid, {
        name,
        ...(parentId !== undefined ? { sourceThoughtId: parentId } : {}),
        ...(relation !== undefined ? { relation: RELATION_VALUES[relation] } : {}),
        ...(typeId !== undefined ? { typeId } : {}),
        ...(label !== undefined ? { label } : {}),
      });

      const done: string[] = [`created thought "${name}" — ${thoughtId}`];
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
        "Changes a thought's properties: title, caption, type, colours. " +
        "Call it to rename or reclassify. It does not touch the note — " +
        "use brain_set_note or brain_append_note for that.",
      inputSchema: {
        brainId,
        thoughtId: z.string().describe("Which thought to change."),
        name: z.string().optional().describe("New title."),
        label: z.string().nullable().optional().describe("Caption; null clears it."),
        typeId: z.string().nullable().optional().describe("Type; null removes the type."),
        foregroundColor: z
          .string()
          .nullable()
          .optional()
          .describe("Text colour, for example #ff7145."),
        backgroundColor: z.string().nullable().optional().describe("Background colour."),
      },
    },
    guard(async ({ brainId: bid, thoughtId, ...changes }) => {
      const provided = Object.entries(changes).filter(([, v]) => v !== undefined);
      if (provided.length === 0) {
        return fail("no fields were supplied to change");
      }
      await ctx.api.thoughts.update(bid, thoughtId, changes);
      return ok(
        section("Done", bullet(provided.map(([k, v]) => `${k} = ${JSON.stringify(v)}`)))!,
      );
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
        'Label the link via name: "motivates", "solved by", "contradicts".',
      inputSchema: {
        brainId,
        fromId: z.string().describe("Source thought."),
        toId: z.string().describe("Target thought."),
        relation: z
          .enum(["child", "parent", "jump", "sibling"])
          .optional()
          .describe(
            "How the target relates to the source. Defaults to jump — a sideways link " +
              "that leaves the hierarchy alone.",
          ),
        name: z.string().optional().describe("Link label: how exactly one relates to the other."),
      },
    },
    guard(async ({ brainId: bid, fromId, toId, relation, name }) => {
      const existing = await ctx.api.links.between(bid, fromId, toId);
      if (existing !== null) {
        if (name !== undefined) await ctx.api.links.update(bid, existing.id, { name });
        return ok(
          section(
            "Link already existed",
            `identifier ${existing.id}` + (name !== undefined ? ", label updated" : ""),
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

export { ThoughtKind };
