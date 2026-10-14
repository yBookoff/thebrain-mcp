/**
 * Write tools.
 *
 * No JSON Patch is exposed: tools take flat fields. Deletion requires human
 * confirmation and only works when it has been enabled by configuration.
 */

import { z } from "zod";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { Relation, ThoughtKind, type LinkDto } from "../../api/types.js";
import {
  MAX_ALIASES,
  TheBrainError,
  assertUuid,
  isStructuralLink,
  isTagLink,
  isTypeLink,
  linksOfPair,
  mayHaveLanded,
  nameRefusal,
  normalizeAliases,
  noteAsStored,
  noteLinesDropped,
  thoughtNameAsStored,
  type AliasOutcome,
  type ApiErrorKind,
  type CleanGraph,
  type TypeOrTagOutcome,
  type UpdateThoughtInput,
} from "../../api/index.js";
import { linkFound } from "../../operations/ingest.js";
import { confirmDestructive, confirmationInstructions } from "../confirm.js";
import type { ServerContext } from "../context.js";
import {
  bullet,
  childrenTitle,
  describeError,
  fail,
  guard,
  join,
  kindMark,
  landedWhy,
  ok,
  section,
  sentence,
  shownName,
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

/** The two kinds a tool makes beside an ordinary thought: the API makes no other. */
const VOCABULARY_KINDS = { type: ThoughtKind.Type, tag: ThoughtKind.Tag } as const;

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

      // Ahead of every request. A name of white space was refused by the API
      // after the reads of the tags and the parent, and a name too long to
      // keep was cut and reported whole. `create` refuses both too.
      const noName = nameRefusal(name, "name");
      if (noName !== null) return fail(`${noName}. Nothing was written.`);
      // The name as it is stored, and spelled out when nothing of it shows:
      // the result is where the caller learns what the thought is called.
      const named = shownName(thoughtNameAsStored(name));

      // Refused, not left out: the thought used to be created with no link
      // and reported as created. `create` refuses it too, in its own terms.
      if (relation !== undefined && parentId === undefined) {
        return fail(
          `relation "${relation}" says how the new thought is linked to parentId, and no ` +
            "parentId was given. Nothing was created. Pass parentId, or leave relation " +
            "out to create a thought with no link.",
        );
      }

      // Ahead of every read, and by the tool's own name for it: `create`
      // checks the same under the API's, after the tags have been read. The
      // identifier of zeros is refused here with a malformed one: the API
      // takes it for no parent given, and the thought was created with none.
      if (parentId !== undefined) assertUuid(parentId, "parentId");
      if (typeId !== undefined) assertUuid(typeId, "typeId");

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
            section("Next", afterNoAnswer(error, named, parentId, hasNote, tags.length > 0)),
          ]),
        );
      }

      const done: string[] = [`created thought "${named}" — ${thoughtId}`];
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
            const warning = notKeptWarning(note);
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
      // Ahead of every request, the type's included. A rename to white space
      // alone is a 200 that changes nothing, and it was listed under "Done".
      const noName = changes.name === undefined ? null : nameRefusal(changes.name, "name");
      if (noName !== null) return fail(`${noName}. Nothing was written.`);
      // A name is given as it is stored, the blanks at its ends dropped, and
      // spelled out when nothing of it shows: `name = "\u200b"` read as `""`.
      const stored = changes.name === undefined ? undefined : thoughtNameAsStored(changes.name);
      const line = ([k, v]: readonly [string, unknown]): string =>
        `${k} = ${JSON.stringify(k === "name" ? shownName(stored) : v)}`;
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
                { name: stored },
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
              `${landedWhy(error, "the write")}, so TheBrain may have replaced the note all ` +
                `the same. ${before} Read the thought with brain_get_thought to see which text ` +
                "it has. Sent again, this call writes the same text.",
            ),
          ]),
        );
      }
      const warning = notKeptWarning(markdown);
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
      // The whole note as it was sent: TheBrain goes over all of it, so a
      // line it deletes need not be one of the lines added.
      let whole: string;
      try {
        whole = await ctx.api.notes.append(bid, thoughtId, markdown);
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
                `${landedWhy(error, "the write")}, so TheBrain may have appended the text ` +
                  "all the same. Read the note with brain_get_thought before sending this call " +
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
      const warning = notKeptWarning(whole, "the note with this text added");
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
        replace: z
          .boolean()
          .optional()
          .describe(
            "Make a link of another kind that joins the two into this one: a jump into a " +
              "parent-child link, or the other end above. It keeps its identifier, and its " +
              "label unless name gives one. Never a tag or a type.",
          ),
      },
    },
    guard(async ({ brainId: bid, fromId, toId, relation, name, replace }) => {
      // Both ends ahead of any read, and by the tool's own names for them:
      // the lookup and the write name the API's, `thoughtIdA` and
      // `thoughtIdB`, and one end used to be read before the other was looked
      // at. A malformed one and the identifier of zeros alike.
      assertUuid(fromId, "fromId");
      assertUuid(toId, "toId");
      // Ahead of everything, the label of a link already there included: under
      // a type a thought is given that type, and loses the one it had, and
      // under a tag it is tagged, which is no link and no parent.
      if (relation === "child") await ctx.api.links.requireParent(bid, fromId, "fromId");
      if (relation === "parent") await ctx.api.links.requireParent(bid, toId, "toId");
      const existing = await ctx.api.links.between(bid, fromId, toId);
      const asked = relation ?? "jump";
      const called = calledByArgument(fromId, toId);
      if (existing !== null) {
        // It used to answer "Link already existed" whatever joined the two,
        // and to write the label onto a tag's attachment or a type's link.
        const found = linkFound(
          existing,
          {
            from: fromId,
            to: toId,
            relation: asked,
            fromName: "fromId",
            toName: "toId",
          },
          name,
        );
        if (!found.ordinary) {
          if (replace === true) return fail(notReplaced(existing, called));
          return ok(section("No link added", found.note)!);
        }
        if (replace === true && !found.asAsked) {
          // Posted over, the link is rewritten to the relation asked for,
          // under its identifier and with its label, colour, thickness and
          // direction (L43). Not over a pair that has another link: that
          // post is refused, and the lookup has shown one of the two. The
          // one link a pair has is what the lookup gives from either end;
          // of two each way it gives each from its own (L43).
          const back = await ctx.api.links.between(bid, toId, fromId);
          const joined =
            back !== null && sameThought(back.id, existing.id)
              ? [existing]
              : linksOfPair(
                  fromId,
                  toId,
                  (await ctx.api.thoughts.getGraph(bid, fromId)).links,
                  existing,
                  back,
                );
          if (joined.length > 1) return fail(severalLinks(joined, called, "brain_link"));
          const linkId = await ctx.api.links.create(bid, {
            thoughtIdA: fromId,
            thoughtIdB: toId,
            relation: RELATION_VALUES[asked],
            ...(found.label?.write === true && name !== undefined ? { name } : {}),
          });
          const was = existing.name ?? "";
          const label =
            found.label !== null
              ? `, ${found.label.said}`
              : was === ""
                ? ""
                : `, and keeps its label ${JSON.stringify(was)}`;
          // Another identifier is a link made where the one read had gone.
          const other = sameThought(linkId, existing.id)
            ? ""
            : `. TheBrain answered with ${linkId}, not ${existing.id}: the link read a moment ` +
              "ago was gone, and this one was made in its place";
          return ok(
            section(
              "Link changed",
              `identifier ${linkId}: from ${linkKind(existing, called)} to ` +
                `${wantedKind(asked)}${label}${other}`,
            )!,
          );
        }
        // A label the link has already is not sent again, and one that takes
        // another's place is quoted: "label updated" used to be all it said,
        // of a label written over as of one that was there already.
        if (found.label?.write === true) await ctx.api.links.update(bid, existing.id, { name });
        return ok(
          section(
            "Link already existed",
            found.asAsked
              ? `identifier ${existing.id}` + (found.label !== null ? `, ${found.label.said}` : "")
              : `identifier ${existing.id}: ${found.note}`,
          )!,
        );
      }
      if (replace === true) {
        // The lookup has no link for two thoughts joined by two the same way,
        // and a post between them is refused (L35): told here, before it.
        const listed = (await ctx.api.thoughts.getGraph(bid, fromId)).links;
        const joined = linksOfPair(fromId, toId, listed, null);
        if (joined.length > 1) return fail(severalLinks(joined, called, "brain_link"));
      }
      const linkId = await ctx.api.links.create(bid, {
        thoughtIdA: fromId,
        thoughtIdB: toId,
        relation: RELATION_VALUES[asked],
        ...(name !== undefined ? { name } : {}),
      });
      return ok(section("Done", `link created — ${linkId}`)!);
    }),
  );

  server.registerTool(
    "brain_unlink",
    {
      description:
        "Removes a link between two thoughts, with its label. There is no undo. Requires " +
        "human confirmation. Call it only when the user asked for the link to go, or for two " +
        "thoughts joined by more than one link. brain_link with replace changes a link's " +
        "kind; a tag goes with brain_tag, a type with brain_update_thought.",
      inputSchema: {
        brainId,
        fromId: z.string().describe("One end of the link."),
        toId: z.string().describe("The other end."),
        linkId: z
          .string()
          .optional()
          .describe("Which link, when more than one joins the two: a call without it lists them."),
        confirm: z.boolean().optional().describe(CONFIRM),
      },
    },
    guard(async ({ brainId: bid, fromId, toId, linkId, confirm }) => {
      if (!ctx.config.allowDestructive) return fail(DELETION_DISABLED);
      assertUuid(fromId, "fromId");
      assertUuid(toId, "toId");
      if (linkId !== undefined) assertUuid(linkId, "linkId");
      if (sameThought(fromId, toId)) {
        return fail(
          `fromId and toId are both ${fromId}, and no link joins a thought to itself. ` +
            "Nothing was removed.",
        );
      }
      const called = calledByArgument(fromId, toId);

      // Both graphs: what joins the two, what each is called, and what else
      // each is linked to. And the lookup from each end, which is not behind
      // a write, as a graph is: a graph read straight after one of two links
      // was removed lists both. It has no link for two the same way.
      const from = await ctx.api.thoughts.getGraph(bid, fromId);
      const to = await ctx.api.thoughts.getGraph(bid, toId);
      const lookup = await ctx.api.links.between(bid, fromId, toId);
      const back = await ctx.api.links.between(bid, toId, fromId);
      const listed = [...from.links, ...to.links];
      const joined = linksOfPair(fromId, toId, listed, lookup, back);
      if (joined.length === 0) {
        // A 404 from both ends is no link, or two or more the same way, and a
        // graph is behind a creation as well as a deletion: one listed link
        // tells neither.
        const seen = [...new Set(listed.filter((l) => ofPair(l, called)).map((l) => l.id))];
        if (seen.length === 1) {
          return fail(
            "TheBrain's lookup has no link between fromId and toId from either end, and " +
              `their graphs list one, ${seen[0]}: it was removed a moment ago, or the two are ` +
              "joined by more than one link, which the lookup cannot see and a graph does not " +
              "list all of yet. Nothing was removed. Send the call again in a moment.",
          );
        }
        return ok(section("Nothing removed", "no link joins fromId and toId")!);
      }

      let link: LinkDto;
      if (linkId !== undefined) {
        const named = joined.find((l) => sameThought(l.id, linkId));
        if (named === undefined) {
          const list = bullet(joined.map((l) => linkLine(l, called)));
          return fail(
            `No link between fromId and toId has the identifier ${linkId}. Nothing was ` +
              `removed. The links that join them:\n${list}`,
          );
        }
        link = named;
      } else if (!joined.some(isStructuralLink)) {
        // Nothing here is this tool's to remove: no linkId would change that.
        return fail(notRemoved(joined[0]!, joined, called));
      } else if (joined.length > 1) {
        return fail(severalLinks(joined, called, "brain_unlink"));
      } else {
        link = joined[0]!;
      }
      // A tag's attachment and a type's link have tools of their own, which
      // know what taking them away does to the thought.
      if (!isStructuralLink(link)) return fail(notRemoved(link, joined, called));

      // What a person agrees to: the two thoughts by name, the link and its
      // label, the links that stay, and a thought the removal leaves with no
      // parent, child or jump, which TheBrain then shows next to nothing.
      const names: Ends = {
        from: fromId,
        to: toId,
        fromName: `"${shownName(from.thought.name)}"${kindMark(from.thought.kind)}`,
        toName: `"${shownName(to.thought.name)}"${kindMark(to.thought.kind)}`,
      };
      const others = joined.filter((l) => l !== link);
      const alone = [
        leftAlone(from, link, others, names) ? names.fromName : null,
        leftAlone(to, link, others, names) ? names.toName : null,
      ].filter((n): n is string => n !== null);
      const summary = join([
        `Remove the link between ${names.fromName} and ${names.toName}?`,
        bullet([
          `${linkKind(link, names)}${labelOf(link)} — ${link.id}`,
          ...others.map((l) => `stays: ${linkKind(l, names)}${labelOf(l)} — ${l.id}`),
          ...alone.map((n) => `${n} would be left with no parent, child or jump`),
        ]),
        "This cannot be undone.",
      ]);

      const outcome = await confirmDestructive(server, summary, confirm === true);
      if (!outcome.granted) {
        return fail(confirmationInstructions(summary, outcome.reason));
      }

      try {
        await ctx.api.links.delete(bid, link.id);
      } catch (error) {
        if (mayHaveLanded(error)) {
          return fail(
            join([
              describeError(error),
              section(
                "Next",
                `${landedWhy(error, "the deletion")}, so TheBrain may have removed the link ` +
                  "all the same. Sent again as it was, this call removes that link if it is " +
                  "there still, and nothing else.",
              ),
            ]),
          );
        }
        // Measured: a link that is gone, and an identifier no link has.
        if (error instanceof TheBrainError && error.kind === "bad_request") {
          return fail(
            `TheBrain answered 400 to the deletion of ${link.id}, its answer for a link that ` +
              "is gone: it was removed a moment ago, after it was read. This call removed " +
              "nothing. Sent again as it was, it says what joins the two now.",
          );
        }
        throw error;
      }
      return ok(
        join([
          section(
            "Removed",
            `the link between ${names.fromName} and ${names.toName}: ` +
              `${linkKind(link, names)}${labelOf(link)} — ${link.id}`,
          ),
          section("Left", others.length === 0 ? null : leftNote(others, names)),
          alone.length === 0
            ? null
            : section(
                "Warning",
                bullet(
                  alone.map(
                    (n) =>
                      `${n} has no parent, child or jump now: TheBrain shows it next to no ` +
                      "thought, and a search finds it. brain_link links it again.",
                  ),
                ),
              ),
        ]),
      );
    }),
  );

  server.registerTool(
    "brain_tag",
    {
      description:
        "Attaches and removes a thought's tags. Tags are separate thoughts of a special " +
        "kind; take their identifiers from brain_list_types_and_tags, and create a new tag " +
        "via brain_create_type_or_tag. A single call can both add and remove.",
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
    "brain_create_type_or_tag",
    {
      description:
        "Creates a thought type or a tag: the vocabulary thoughts are classified with, " +
        "which brain_create_thought cannot make. Call it when brain_list_types_and_tags " +
        "has none that fits. Under the name of a tag the brain has, in any letter case, no " +
        "second tag is made and the result gives that one. A type is made even when " +
        "another has the name.",
      inputSchema: {
        brainId,
        kind: z
          .enum(["type", "tag"])
          .describe("A type is what typeId takes; a tag is what brain_tag and tagIds take."),
        name: z.string().min(1).describe("Its name, as TheBrain will show it."),
      },
    },
    guard(async ({ brainId: bid, kind, name }) => {
      // Ahead of every request, as for a thought: a name of white space is a
      // 400 for a type and a tag too, and one too long to keep is cut.
      const noName = nameRefusal(name, "name");
      if (noName !== null) return fail(`${noName}. Nothing was written.`);
      const asked = shownName(thoughtNameAsStored(name));

      let outcome: TypeOrTagOutcome;
      try {
        outcome = await ctx.api.thoughts.createTypeOrTag(bid, {
          name,
          kind: VOCABULARY_KINDS[kind],
        });
      } catch (error) {
        if (mayHaveLanded(error)) {
          // A create with no answer is not a create that failed. What a
          // second call does is the API's, and not the same for the two: a
          // tag of the name is answered with, and a type is made again.
          return fail(
            join([
              describeError(error),
              section(
                "Next",
                `${landedWhy(error, "the create")}, so TheBrain may have made the ${kind} ` +
                  `"${asked}" all the same, and there is no identifier to give for it. ` +
                  (kind === "tag"
                    ? "Send this call again: under the name of a tag the brain has TheBrain " +
                      "makes no second one, and the result gives the tag that is there."
                    : "Before creating it again, look for it with brain_list_types_and_tags, " +
                      "which lists a new type within half a second or so: sent again, this " +
                      "call makes a second type of the same name."),
              ),
            ]),
          );
        }
        // The one GET ahead of the create is the read of the log, and its
        // failure alone said nothing of what it was for or of the create.
        const atTheRead = error instanceof TheBrainError && error.method === "GET";
        if (!atTheRead || aboutTheCall(error)) throw error;
        return fail(
          `Nothing was created. The brain's log is read before a ${kind} is made, to tell ` +
            "one this call makes from one that was there, and that read failed: " +
            `${sentence(describeError(error))} This call can be sent again as it is.`,
        );
      }

      const { id, created, thought } = outcome;
      const use =
        kind === "tag"
          ? "pass it to brain_tag, or in tagIds to brain_create_thought or brain_ingest"
          : "pass it as typeId to brain_create_thought, brain_update_thought or brain_ingest";
      if (thought === null) {
        // The create was answered, so its identifier is not to be lost to a
        // read that failed after it: thrown, the call sent again would make
        // a second type. No name was read, and a tag that was there keeps
        // its own, so the name is given as the one asked for and no more.
        const had = created === null ? "has" : created ? "has, made by this call," : "had";
        return writtenInPart(
          [`the brain ${had} the ${kind} ${id}, asked for as "${asked}"`],
          {
            what:
              created === null
                ? `whether this call made it, or TheBrain answered with a ${kind} that was there`
                : `the read of the ${kind} after the create`,
            error: outcome.notRead,
            skipped: [],
          },
          `The identifier works immediately: do not create the ${kind} again. Read it with ` +
            `brain_get_thought, then ${use}.`,
        );
      }

      // By what was read, name and kind: the mark is the thought's own.
      const line = `${kind} "${shownName(thought.name)}" — ${id}${kindMark(thought.kind)}`;
      if (created) {
        return ok(
          join([
            section("Done", bullet([`created ${line}`])),
            section(
              "Next",
              `The identifier above works immediately: ${use}. brain_list_types_and_tags ` +
                `lists the new ${kind} within half a second or so, and brain_update_thought ` +
                "gives it a caption or colours.",
            ),
          ]),
        );
      }
      // "Existed" is not "created", and the name is the one the brain has:
      // TheBrain matches a tag's name loosely, and answers with a tag whose
      // name is not the one asked for (docs/api-map.md, L39).
      const otherName =
        thought.name === thoughtNameAsStored(name)
          ? ""
          : `Its name is "${shownName(thought.name)}", not "${asked}" as asked for` +
            (kind === "tag"
              ? ": TheBrain takes two names for one tag when they differ in letter case, in " +
                "characters that do not show, or in the form of a character, such as a " +
                "ligature, a superscript or a no-break space. "
              : ". ");
      return ok(
        join([
          section("Already there", bullet([line])),
          section(
            "Note",
            `No ${kind} was created: the brain had this one, and TheBrain answered the create ` +
              `with it. ${otherName}It is as it was, and the identifier above is the one to ` +
              `use: ${use}.`,
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
      // Found under another spelling, the one stored is what the thought shows.
      const stored = result.existing?.location;
      const as = stored != null && stored !== url ? ` (stored as ${stored})` : "";
      return ok(
        result.created
          ? section("Done", `link attached: ${url}`)!
          : section(
              "Already there",
              `this URL is already attached as "${result.existing?.name ?? "unnamed"}"${as} — nothing changed`,
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
        confirm: z.boolean().optional().describe(CONFIRM),
      },
    },
    guard(async ({ brainId: bid, thoughtId, confirm }) => {
      if (!ctx.config.allowDestructive) return fail(DELETION_DISABLED);

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
      const named = `"${shownName(graph.thought.name)}"${kindMark(graph.thought.kind)}`;
      // What a person agrees to, so each line is what it says. Under a type
      // or a tag the graph's `children` are the thoughts of that type or with
      // that tag, as the read tools title them, and were counted as children.
      // And the note is an attachment to the API (`isNotes`): it was counted
      // on its own line and again among the attachments.
      const under = childrenTitle(graph.thought.kind).toLowerCase();
      const attached = graph.attachments.filter((a) => !a.isNotes).length;
      const summary = join([
        `Delete the thought ${named}?`,
        bullet(
          [
            `links: ${graph.links.length}`,
            `${under}: ${graph.children.length}`,
            note.trim() === "" ? null : `note: ${note.length} characters`,
            attached > 0 ? `attachments: ${attached}` : null,
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
        bullet([`${stopped.what}: ${reason}${unanswered(stopped.error)}`]),
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

/** Added to a write that may have been carried out, which is not a write that failed. */
function unanswered(error: unknown): string {
  if (!mayHaveLanded(error)) return "";
  const why = landedWhy(error);
  return (
    ` — ${why.charAt(0).toLowerCase()}${why.slice(1)}, ` +
    "so TheBrain may have carried it out all the same"
  );
}

/** What a tool that deletes answers before anything else, with the gate shut. */
const DELETION_DISABLED =
  "deletion is disabled. To allow it, start the server with " +
  "THEBRAIN_ALLOW_DESTRUCTIVE=1 — that is a deliberate choice by the user, " +
  "not something to work around.";

/** The `confirm` of a tool that deletes. */
const CONFIRM =
  "Set to true only after a human has confirmed the deletion. " +
  "Do not decide this on their behalf.";

/** Case aside: the API reads a UUID in capitals too. */
function sameThought(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * The two thoughts a call about a link names, and what a result calls each:
 * by the arguments, as `linkFound()` does, or by name in what a person reads.
 */
interface Ends {
  from: string;
  to: string;
  fromName: string;
  toName: string;
}

function calledByArgument(from: string, to: string): Ends {
  return { from, to, fromName: "fromId", toName: "toId" };
}

/**
 * What a link is, said from the two thoughts of a call: "jump", "parent-child
 * with fromId above", or what a tag's or a type's link makes of the two, in
 * `linkFound()`'s words. `thoughtIdA` is the upper end of a parent-child link,
 * the tag and the type (L29).
 */
function linkKind(link: LinkDto, ends: Ends): string {
  const [head, tail] = sameThought(link.thoughtIdA, ends.from)
    ? [ends.fromName, ends.toName]
    : [ends.toName, ends.fromName];
  if (isTagLink(link)) return `${head} is a tag on ${tail}`;
  if (isTypeLink(link)) return `${head} is the type of ${tail}`;
  if (!isStructuralLink(link)) return `a link of another kind (meaning ${link.meaning})`;
  if (link.relation === Relation.Jump) return "jump";
  if (link.relation === Relation.Child) return `parent-child with ${head} above`;
  return `a link of relation ${link.relation}`;
}

/** What `brain_link` was asked for, in the same words. */
function wantedKind(relation: keyof typeof RELATION_VALUES): string {
  if (relation === "jump") return "jump";
  return `parent-child with ${relation === "child" ? "fromId" : "toId"} above`;
}

/** A link's label as a clause, or nothing for a link with none. */
function labelOf(link: LinkDto): string {
  return link.name === null || link.name === "" ? "" : `, labelled ${JSON.stringify(link.name)}`;
}

/** A link as a line of a list: its identifier, what it is, its label. */
function linkLine(link: LinkDto, ends: Ends): string {
  return `${link.id}: ${linkKind(link, ends)}${labelOf(link)}`;
}

/**
 * Two thoughts joined by more than one link. A post between them is refused,
 * the lookup cannot see two that go the same way, and only a deletion leaves
 * one (L35, L43): so the links are listed by identifier, for `brain_unlink`.
 */
function severalLinks(
  joined: readonly LinkDto[],
  ends: Ends,
  tool: "brain_link" | "brain_unlink",
): string {
  const list = bullet(joined.map((l) => linkLine(l, ends)));
  if (tool === "brain_unlink") {
    return (
      `fromId and toId are joined by ${joined.length} links. Nothing was removed: send the ` +
      `call again with the linkId of the one to remove.\n${list}`
    );
  }
  return (
    `fromId and toId are joined by ${joined.length} links, and TheBrain posts nothing ` +
    "between two thoughts joined by more than one, so none of them can be changed. Nothing " +
    `was written.\n${list}\nRemove all but one with brain_unlink, naming each by its ` +
    "linkId; brain_link then finds the one left, and replace changes it."
  );
}

/** `brain_link` with replace, over a tag's attachment or a type's link. */
function notReplaced(link: LinkDto, ends: Ends): string {
  const way = isTagLink(link)
    ? " To link the two another way, take the tag off with brain_tag first."
    : isTypeLink(link)
      ? " To link the two another way, take the type away first, with typeId null in " +
        "brain_update_thought."
      : "";
  return (
    `${linkKind(link, ends)}: replace changes an ordinary link, never a tag's attachment or ` +
    `a type's link. Nothing was written.${way}`
  );
}

/** `brain_unlink` named a link that is not an ordinary one. */
function notRemoved(link: LinkDto, joined: readonly LinkDto[], ends: Ends): string {
  const what = linkKind(link, ends);
  if (isTagLink(link)) {
    // Two attachments of one tag: the lookup `detachTag()` goes by has
    // neither, as for any pair joined twice (L43).
    const twice = joined.filter((l) => isTagLink(l) && sameThought(l.thoughtIdA, link.thoughtIdA));
    return (
      `${what}: a tag's attachment, which brain_unlink does not remove. Nothing was removed. ` +
      "Take the tag off with brain_tag." +
      (twice.length > 1
        ? ` The tag is attached ${twice.length} times, and brain_tag finds none of them ` +
          "while it is: all but one are removed in TheBrain itself."
        : "")
    );
  }
  if (isTypeLink(link)) {
    return (
      `${what}: a type's link, which brain_unlink does not remove. Nothing was removed. ` +
      "Take the type away with typeId null in brain_update_thought."
    );
  }
  return `${what}, which brain_unlink does not remove. Nothing was removed.`;
}

/**
 * Whether an ordinary thought is left with no parent, child or jump once
 * `link` is gone, of the pair `ends` names. A type or a tag has none as a
 * rule. The graph is a copy: of the pair's links it can list one removed a
 * moment ago (L43), so those count only as `others`, what joins the pair
 * besides `link`. A link made a moment ago may not be counted at all: it
 * errs towards the warning.
 */
function leftAlone(
  graph: CleanGraph,
  link: LinkDto,
  others: readonly LinkDto[],
  ends: Ends,
): boolean {
  const { kind } = graph.thought;
  if (kind === ThoughtKind.Type || kind === ThoughtKind.Tag) return false;
  return !graph.links.some(
    (l) =>
      isStructuralLink(l) &&
      !sameThought(l.id, link.id) &&
      (!ofPair(l, ends) || others.some((o) => sameThought(o.id, l.id))),
  );
}

/** Whether a link joins the two thoughts `ends` names, either way. */
function ofPair(link: LinkDto, ends: Ends): boolean {
  const end = (id: string): boolean => sameThought(id, ends.from) || sameThought(id, ends.to);
  return end(link.thoughtIdA) && end(link.thoughtIdB);
}

/** What still joins two thoughts after one of their links is removed. */
function leftNote(others: readonly LinkDto[], ends: Ends): string {
  const list = bullet(others.map((l) => linkLine(l, ends)));
  return others.length === 1
    ? `${list}\nIt is the one link the two have now: brain_link finds it, and with replace ` +
        "changes it."
    : `${list}\nStill more than one: TheBrain posts nothing between the two while it is so.`;
}


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
 * What follows a create that may have been carried out (`mayHaveLanded()`):
 * no answer, one that broke off, or the catch-all 403. The thought may be there with no
 * identifier to give, so this says where to look before it is created again:
 * next to its parent, or, for a thought created with none, by name. The
 * index knows a new thought only after a sync, and a search that missed it
 * for that reason would be read as "not there".
 */
function afterNoAnswer(
  error: unknown,
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
    `${landedWhy(error, "the create")}, so TheBrain may have made "${name}" all the same, ` +
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

/**
 * The two rules by which TheBrain deletes a line of a note it is given
 * (`noteLinesDropped()`), and what to do about a note that lost one.
 */
export const FENCE_RULE =
  "TheBrain deletes the last line that begins with ``` when a note has an odd number of " +
  "them, with whatever else is on that line, and a code block with nothing between its " +
  "two ``` lines.";
export const AFTER_A_LINE_LOST =
  "with brain_get_thought, and write it again with brain_set_note with a ``` line before " +
  "each code block and one after it, each at the start of its line, and no other line " +
  "that begins with ```.";

/**
 * Which lines of a note TheBrain did not keep, as a result names them, or
 * null for a note it kept whole: any note whose code blocks are each closed.
 * A line is given by its number in the text as sent and by what it held,
 * since a line that opens with a code span goes with its sentence.
 */
export function linesNotKept(markdown: string): string | null {
  const dropped = noteLinesDropped(markdown);
  const parts: string[] = [];
  for (let i = 0; i < dropped.length; i += 1) {
    const { line, text, why } = dropped[i]!;
    if (why === "empty") {
      // The two fences of one block, which are lines next to each other.
      parts.push(`lines ${line} and ${line + 1}, a code block with nothing in it`);
      i += 1;
    } else {
      const shown = text.length > 60 ? `${text.slice(0, 60)}…` : text;
      parts.push(`line ${line}, ${JSON.stringify(shown)}`);
    }
  }
  return parts.length === 0 ? null : parts.join("; ");
}

/**
 * The warning of a tool that wrote one note, or null when TheBrain kept all
 * of it. `of` is the text the line numbers count in.
 *
 * It used to be given for every note with a fenced block, as a note whose
 * closing fence TheBrain drops. A block that is closed reads back to the
 * character (contract test), so that warning was untrue of nearly every note
 * it stood under, and its advice to indent code changed how a note looks.
 */
function notKeptWarning(markdown: string, of = "this note"): string | null {
  const lines = linesNotKept(markdown);
  if (lines === null) return null;
  const nothing =
    noteAsStored(markdown).trim() === ""
      ? " Nothing else was in the note, so the thought reads as having none."
      : "";
  return (
    `TheBrain did not keep ${lines}, of ${of}. ${FENCE_RULE}${nothing} ` +
    `Read the note ${AFTER_A_LINE_LOST}`
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
