/**
 * Read tools.
 *
 * Descriptions deliberately say **when** to call a tool, not only what it
 * does: that is what drives the model's routing. They sit in context
 * permanently, so they are written tightly.
 */

import { z } from "zod";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { TheBrainError } from "../../api/errors.js";
import { compareLogTime, logTime } from "../../api/log.js";
import { ThoughtKind, aliasesOf, type ModificationLogDto } from "../../api/types.js";
import { describeChange, isSettingNoise, subjectIds } from "../../operations/changes.js";
import { traverse, type TraverseUnread } from "../../operations/traverse.js";
import { mapWithConcurrency } from "../../semantic/indexer.js";
import {
  SearchFailedError,
  type PhrasingFailure,
  type SearchOutcome,
} from "../../semantic/search.js";
import type { ServerContext } from "../context.js";
import {
  bullet,
  describeError,
  fail,
  guard,
  join,
  kindLabel,
  kindMark,
  ok,
  section,
  sentence,
  table,
} from "../respond.js";

const brainId = z
  .string()
  .describe("Brain identifier. Take it from brain_list — never guess it.");

/** Cap on how many names the log resolves: beyond this the output is unreadable anyway. */
const MAX_RESOLVED_NAMES = 60;

/**
 * What `brain_recent_changes` prints for a thought it has no name for. Neither
 * is `(unnamed)`, which here as in the other tools is a thought that is there
 * and has no name.
 *
 * `DELETED`: the read of the thought answered 404, as it does for an
 * identifier nobody has (docs/api-map.md, L3). The log is this brain's, so the
 * thought was here and is not now.
 *
 * `NOT_READ`: the name was not looked up, being past the cap, or its read
 * failed some other way. Nothing is known of the thought, least of all that
 * it is gone.
 */
const DELETED = "(deleted)";
const NOT_READ = "(name not read)";

/**
 * The title for what a graph lists as `children`. Under a type those are the
 * thoughts of that type, and under a tag the thoughts the tag is on: a link
 * with a type or a tag above is the type's or the tag's, never a parent's
 * (docs/api-map.md, L23 and L24). "Children" there sends a model to add one,
 * which the write tools refuse (`not_a_parent`, `tag_as_parent`). Any other
 * thought keeps the title it had.
 */
function childrenTitle(kind: number): string {
  if (kind === ThoughtKind.Type) return "Thoughts of this type";
  if (kind === ThoughtKind.Tag) return "Thoughts with this tag";
  return "Children";
}

/**
 * Cap on search phrasings. Each one costs an embedding and a full scan in
 * vector mode, run one after another, or a request to TheBrain's search in the
 * fallback.
 */
const MAX_VARIANTS = 10;

/** How much of a phrasing a result quotes: a passage given for one is not sent back whole. */
const QUOTED_CHARS = 60;

function quoted(phrasing: string): string {
  if (phrasing.length <= QUOTED_CHARS) return JSON.stringify(phrasing);
  const start = JSON.stringify(`${phrasing.slice(0, QUOTED_CHARS)}…`);
  return `${start} (${phrasing.length} characters)`;
}

/** Why a phrasing got no answer, as any tool would explain that failure. */
function reason(failure: PhrasingFailure): string {
  return sentence(describeError(failure.error));
}

/** One line for each phrasing that got no answer: the phrasing, and why. */
function failureLines(failures: readonly PhrasingFailure[]): string {
  return bullet(failures.map((f) => `${quoted(f.phrasing)}: ${reason(f)}`));
}

/**
 * What `brain_search` answers when no phrasing was answered. It is an error,
 * and it says that nothing was searched: read as an empty result, a search
 * that never ran tells the model the brain holds no such thought.
 *
 * One reason for all of them is given once. That is TheBrain not running, or
 * failing: the failures that are not one phrasing's own.
 */
function nothingSearched(error: SearchFailedError): string {
  const lead = "Nothing was searched, and this is no answer about what the brain holds";
  const count = error.failures.length;
  const reasons = new Set(error.failures.map(reason));
  if (reasons.size > 1) {
    return `${lead}. Each of the ${count} phrasings failed:\n${failureLines(error.failures)}`;
  }
  const [shared] = reasons;
  const all = count > 1 ? ` Each of the ${count} phrasings failed this way.` : "";
  return `${lead}: ${shared}${all}`;
}

/**
 * The phrasings that were left out of a result, or null when none was.
 * Without it "not found" reads as certain, and one phrasing more might have
 * found the thought.
 */
function notSearchedSection(outcome: SearchOutcome): string | null {
  const skipped = outcome.notSearched.length;
  if (skipped === 0) return null;
  const rest = outcome.phrasings - skipped;
  return section(
    "Not searched",
    `${skipped} of ${outcome.phrasings} phrasings got no answer from TheBrain's search, ` +
      `so this result is from the other ${rest === 1 ? "one" : rest} only:\n` +
      failureLines(outcome.notSearched),
  );
}

/**
 * The body of the result's first section. With no hit the fallback says so
 * in words, and of how many phrasings: it used to print no section at all,
 * which is also all it printed when every request had failed.
 */
function foundBody(outcome: SearchOutcome, hits: string): string {
  if (outcome.mode === "vector" || outcome.matches.length > 0) return hits;
  const answered = outcome.phrasings - outcome.notSearched.length;
  if (outcome.phrasings === 1) return "Nothing: TheBrain's search matched no thought.";
  const which = answered === outcome.phrasings ? "" : " it answered";
  return answered === 1
    ? `Nothing: TheBrain's search matched no thought for the one phrasing${which}.`
    : `Nothing: TheBrain's search matched no thought for any of the ${answered} phrasings${which}.`;
}

/** A read that was answered, or the failure that came in its place. */
type Read<T> = { value: T } | { error: unknown };

/**
 * Keeps a read's failure beside the reads that are awaited with it, so that
 * the result can say what was not read. Dropped, it used to pass for the
 * answer of something that is not there: `.catch(() => "")` made a note that
 * was not read a thought with no note.
 */
function kept<T>(read: Promise<T>): Promise<Read<T>> {
  return read.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
}

/**
 * What `brain_get_thought` prints where the note goes when the note's read
 * failed. No section at all is what a thought with no note prints, and the
 * model acts on that with a write that erases the note.
 */
function noteNotRead(error: unknown): string | null {
  return section(
    "Note not read",
    "The read of this thought's note failed, so this result does not say whether it has " +
      `one: ${sentence(describeError(error))} The rest is as TheBrain returned it. Call ` +
      "brain_get_thought again before relying on the note or replacing it.",
  );
}

/**
 * What `brain_list` adds when the app's state could not be read. Without it
 * no row is marked open and no active thought is printed, which is also what
 * an app with no brain open prints.
 */
function stateNotRead(error: unknown): string | null {
  return section(
    "Open brain not read",
    "Which brain is open in the app, and its active thought, could not be read: " +
      `${sentence(describeError(error))} The brains above are all of them.`,
  );
}

/**
 * The thoughts a walk reached and could not look around, or null when it
 * read them all. Each is listed in its hop like any other, and without this
 * it reads as one with nothing next to it.
 *
 * One reason for all of them is given once, as `brain_search` gives it.
 */
function notReadSection(unread: readonly TraverseUnread[]): string | null {
  if (unread.length === 0) return null;
  const one = unread.length === 1;
  const lead =
    `${one ? "The graph of one thought" : `The graphs of ${unread.length} thoughts`} on the ` +
    `way could not be read, so what lies beyond ${one ? "it" : "them"} is missing from this result`;
  const named = (u: TraverseUnread): string => `${u.name} — ${u.id}`;
  const why = (u: TraverseUnread): string => sentence(describeError(u.error));
  const reasons = new Set(unread.map(why));
  if (reasons.size > 1) {
    return section("Not read", `${lead}:\n${bullet(unread.map((u) => `${named(u)}: ${why(u)}`))}`);
  }
  const [shared] = reasons;
  return section("Not read", `${lead}: ${shared}\n${bullet(unread.map(named))}`);
}

export function registerReadTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "brain_list",
    {
      description:
        "Lists the user's brains and which one is currently open in the app. " +
        "Call this first in any session: every other tool needs a brainId and " +
        "guessing one is not allowed. Also shows whether the semantic index is ready.",
      inputSchema: {},
    },
    guard(async () => {
      const [brains, appState] = await Promise.all([
        ctx.api.brains.list(),
        kept(ctx.api.app.state()),
      ]);
      const state = "value" in appState ? appState.value : null;

      const rows = brains.map((b) => {
        const status = ctx.indexer(b.id).status(b.id);
        return [
          b.name ?? "(unnamed)",
          b.id,
          b.id === state?.currentBrainId ? "open" : "",
          status.compatible ? `index: ${status.size}` : "no index",
        ];
      });

      return ok(
        join([
          section("Brains", table(["Name", "Identifier", "", "Semantic"], rows)),
          state?.activeThoughtName
            ? section(
                "Active thought",
                `${state.activeThoughtName} (${state.activeThoughtId})`,
              )
            : null,
          // The list is whole without it, so this is no error: nothing is
          // written by which brain is open, and brainId is never taken from it.
          "error" in appState ? stateNotRead(appState.error) : null,
        ]),
      );
    }),
  );

  server.registerTool(
    "brain_get_thought",
    {
      description:
        "A thought in full: note, aliases, parents, children, jumps, tags, type and attachments in one call. " +
        "The main way to understand a thought's context. Call it when you need to know " +
        "what a thought is about and how it connects, before changing or extending it.",
      inputSchema: {
        brainId,
        thoughtId: z.string().describe("Thought identifier."),
        includeSiblings: z
          .boolean()
          .optional()
          .describe("Include siblings under the same parent. Off by default — there can be many."),
      },
    },
    guard(async ({ brainId: bid, thoughtId, includeSiblings }) => {
      const [graph, note] = await Promise.all([
        ctx.api.thoughts.getGraph(bid, thoughtId, {
          includeSiblings: includeSiblings ?? false,
        }),
        // Kept when it fails: a thought with no note is a 200 from this read
        // (docs/api-map.md, L3), so a failure is never that answer. The
        // graph's own failure is the call's, as it was.
        kept(ctx.api.notes.get(bid, thoughtId)),
      ]);

      // A type or a tag among them is marked: any of these lists can hold one,
      // and a write refuses it where an ordinary thought was meant.
      const names = (
        list: ReadonlyArray<{ name: string | null; id: string; kind: number }>,
      ): string[] => list.map((t) => `${t.name ?? "(unnamed)"} — ${t.id}${kindMark(t.kind)}`);

      // A thought printed without its note is an error, so that it is not
      // read as the thought in full: the rest is there, and the note is not.
      return ("error" in note ? fail : ok)(
        join([
          `# ${graph.thought.name ?? "(unnamed)"}\n${graph.thought.id}${kindMark(graph.thought.kind)}`,
          // One per line: an alias may hold a comma, and the list gets edited by value.
          section("Aliases", bullet(aliasesOf(graph.thought))),
          // With its identifier: that is what a typeId takes.
          graph.type
            ? section("Type", `${graph.type.name ?? "(unnamed)"} — ${graph.type.id}`)
            : null,
          graph.tags.length > 0
            ? section("Tags", graph.tags.map((t) => t.name ?? "").join(", "))
            : null,
          section("Parents", bullet(names(graph.parents))),
          section(childrenTitle(graph.thought.kind), bullet(names(graph.children))),
          section("Jumps", bullet(names(graph.jumps))),
          includeSiblings ? section("Siblings", bullet(names(graph.siblings))) : null,
          graph.attachments.length > 0
            ? section(
                "Attachments",
                bullet(
                  graph.attachments.map(
                    (a) => `${a.name ?? "(unnamed)"}${a.location ? ` — ${a.location}` : ""}`,
                  ),
                ),
              )
            : null,
          "error" in note
            ? noteNotRead(note.error)
            : note.value.trim() === ""
              ? null
              : section("Note", note.value),
        ]),
      );
    }),
  );

  server.registerTool(
    "brain_search",
    {
      description:
        "Finds thoughts by meaning. Call it when looking for something by description " +
        "rather than exact title — for instance to check whether a thought on this topic " +
        "already exists. Always pass variants: several phrasings of the same concept " +
        "(synonyms, translation, a broader and a narrower term). They raise recall " +
        "noticeably, and if the semantic index is not built they are all that works.",
      inputSchema: {
        brainId,
        query: z.string().describe("What you are looking for, in your own words."),
        variants: z
          .array(z.string())
          .max(MAX_VARIANTS)
          .optional()
          .describe(
            "Other phrasings of the same concept: synonyms, a translation into the " +
              `second language, a broader and a narrower term. Three to six of them, at most ${MAX_VARIANTS}.`,
          ),
        limit: z.number().int().min(1).max(50).optional().describe("Defaults to 15."),
        includeAuxiliary: z
          .boolean()
          .optional()
          .describe("Include types and tags in results. By default only ordinary thoughts."),
      },
    },
    guard(async ({ brainId: bid, query, variants, limit, includeAuxiliary }) => {
      let outcome: SearchOutcome;
      try {
        outcome = await ctx.search(bid).find(bid, query, {
          ...(variants !== undefined ? { variants } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(includeAuxiliary !== undefined ? { includeAuxiliary } : {}),
        });
      } catch (error) {
        if (error instanceof SearchFailedError) return fail(nothingSearched(error));
        throw error;
      }

      // The column is there only when a hit is not an ordinary thought, and a
      // type or a tag is one only with includeAuxiliary: a result of ordinary
      // thoughts reads as it did.
      const kinds = outcome.matches.map((m) => kindLabel(m.kind));
      const kindColumn = kinds.some((k) => k !== null);
      const rows = outcome.matches.map((m, i) => [
        m.score.toFixed(3),
        m.name,
        m.thoughtId,
        ...(kindColumn ? [kinds[i] ?? ""] : []),
        m.matchedVariant ?? "",
      ]);

      return ok(
        join([
          section(
            outcome.mode === "vector" ? "Found by meaning" : "Found by substring",
            foundBody(
              outcome,
              table(
                ["Score", "Thought", "Identifier", ...(kindColumn ? ["Kind"] : []), "Matched"],
                rows,
              ),
            ),
          ),
          notSearchedSection(outcome),
          outcome.degradedReason === null
            ? null
            : section(
                "Warning",
                `Semantic search unavailable: ${outcome.degradedReason}. ` +
                  "Fell back to substring name search, so recall is lower. " +
                  "Build the index with the brain_index tool.",
              ),
        ]),
      );
    }),
  );

  server.registerTool(
    "brain_traverse",
    {
      description:
        "Walks the graph several hops out from a thought. Call it when you need to see " +
        "the whole neighbourhood: which region of the brain adjoins a topic, where new " +
        "material should slot in, what already sits nearby. Viewing a thought shows one hop only.",
      inputSchema: {
        brainId,
        thoughtId: z.string().describe("Where to start."),
        depth: z.number().int().min(1).max(4).optional().describe("Hops. Defaults to 2."),
        follow: z
          .array(z.enum(["child", "parent", "jump"]))
          .optional()
          .describe("Which link kinds to follow. All of them by default."),
        maxNodes: z
          .number()
          .int()
          .min(10)
          .max(500)
          .optional()
          .describe("Safety valve. Defaults to 150."),
      },
    },
    guard(async ({ brainId: bid, thoughtId, depth, follow, maxNodes }) => {
      const result = await traverse(ctx.api, bid, thoughtId, {
        ...(depth !== undefined ? { depth } : {}),
        ...(follow !== undefined ? { follow } : {}),
        ...(maxNodes !== undefined ? { maxNodes } : {}),
      });

      const byDepth = new Map<number, string[]>();
      for (const node of result.nodes) {
        if (node.depth === 0) continue;
        const line = node.path.length > 0
          ? `${node.name} — ${node.id}${kindMark(node.kind)}  (via ${node.path.join(" -> ")})`
          : `${node.name} — ${node.id}${kindMark(node.kind)}`;
        byDepth.set(node.depth, [...(byDepth.get(node.depth) ?? []), line]);
      }

      const root = result.nodes.find((n) => n.depth === 0);
      const labelled = result.edges.filter((e) => e.name !== null);

      return ok(
        join([
          `# Neighbourhood of: ${root?.name ?? thoughtId}${root ? kindMark(root.kind) : ""}`,
          ...[...byDepth.entries()]
            .sort(([a], [b]) => a - b)
            .map(([d, items]) => section(`Hop ${d}`, bullet(items))),
          labelled.length > 0
            ? section(
                "Labelled links",
                bullet(
                  labelled.map((e) => {
                    const from = result.nodes.find((n) => n.id === e.from)?.name ?? e.from;
                    const to = result.nodes.find((n) => n.id === e.to)?.name ?? e.to;
                    return `${from} -> ${e.name} -> ${to}`;
                  }),
                ),
              )
            : null,
          notReadSection(result.unread),
          section(
            "Totals",
            `thoughts ${result.nodes.length}, links ${result.edges.length}` +
              (result.truncated ? " (traversal hit the limit, there is more)" : "") +
              (result.unread.length > 0
                ? ` (${result.unread.length} not read, there may be more beyond)`
                : ""),
          ),
        ]),
      );
    }),
  );

  server.registerTool(
    "brain_list_types_and_tags",
    {
      description:
        "The brain's vocabulary: which thought types and tags exist. Call it before " +
        "creating thoughts so you use this brain's established conventions instead of " +
        "inventing new ones.",
      inputSchema: { brainId },
    },
    guard(async ({ brainId: bid }) => {
      const [types, tags] = await Promise.all([
        ctx.api.thoughts.listTypes(bid),
        ctx.api.thoughts.listTags(bid),
      ]);
      return ok(
        join([
          section("Types", bullet(types.map((t) => `${t.name ?? "(unnamed)"} — ${t.id}`))),
          section("Tags", bullet(tags.map((t) => `${t.name ?? "(unnamed)"} — ${t.id}`))),
          types.length === 0 && tags.length === 0
            ? section("Note", "This brain has no types or tags yet.")
            : null,
        ]),
      );
    }),
  );

  server.registerTool(
    "brain_recent_changes",
    {
      description:
        "What changed in the brain over a period, in plain language. Call it for digests " +
        '("what did I add this week") and to understand what work was in progress ' +
        "before continuing it.",
      inputSchema: {
        brainId,
        since: z
          .string()
          .optional()
          .describe(
            "ISO timestamp to start from, UTC unless it carries an offset. " +
              "Defaults to the last seven days.",
          ),
        limit: z.number().int().min(1).max(500).optional().describe("Defaults to 100."),
      },
    },
    guard(async ({ brainId: bid, since, limit }) => {
      const from = since ?? new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
      const want = limit ?? 100;

      // The caller's limit cannot go to the API: it keeps the newest entries,
      // and those can all be settings. So pages are read, newest first, until
      // one event more than the limit shows there is something left out.
      const events: ModificationLogDto[] = [];
      const settings: string[] = [];
      for await (const page of ctx.api.brains.modificationPages(bid, { since: from })) {
        for (const l of page) {
          if (isSettingNoise(l)) settings.push(logTime(l));
          else events.push(l);
        }
        if (events.length > want) break;
      }
      const newestFirst = (a: ModificationLogDto, b: ModificationLogDto): number =>
        compareLogTime(logTime(b), logTime(a));
      const logs = events.sort(newestFirst).slice(0, want);
      const cut = events.length > want;
      // Settings count only within the period the rows cover.
      const lastShown = logs.at(-1);
      const oldestShown = lastShown === undefined ? undefined : logTime(lastShown);
      const hidden =
        cut && oldestShown !== undefined
          ? settings.filter((t) => compareLogTime(t, oldestShown) >= 0).length
          : settings.length;

      // Names are resolved in one bounded batch: otherwise a large `limit`
      // turns into hundreds of sequential requests.
      const unique = [...new Set(logs.flatMap(subjectIds))].slice(0, MAX_RESOLVED_NAMES);
      const resolved = await mapWithConcurrency(unique, 10, async (id) => {
        const name = await ctx.api.thoughts.get(bid, id).then(
          // The read that resolves the name has the kind: a tag attached is
          // logged as a link created, and reads as one unless the tag is marked.
          (t) => `${t.name ?? "(unnamed)"}${kindMark(t.kind)}`,
          // Not "(unnamed)" for a read that failed: a thought deleted since
          // would read as one that is there, in every row about it.
          (error: unknown) =>
            error instanceof TheBrainError && error.kind === "not_found" ? DELETED : NOT_READ,
        );
        return [id, name] as const;
      });
      const thoughtNames = new Map(resolved);

      const rows = logs.map((l) => [
        logTime(l).slice(0, 16).replace("T", " "),
        describeChange(l),
        subjectIds(l)
          .map((id) => thoughtNames.get(id) ?? NOT_READ)
          .join(" ↔ "),
      ]);

      const totals = [
        `events ${logs.length}`,
        hidden > 0 ? `brain-setting changes hidden: ${hidden}` : null,
        cut ? "older events not shown — raise `limit`" : null,
      ].filter((s) => s !== null);

      return ok(
        join([
          section(
            `Changes since ${from.slice(0, 16).replace("T", " ")}`,
            table(["When (UTC)", "What", "Thought"], rows),
          ),
          section("Totals", totals.join("; ")),
        ]),
      );
    }),
  );

  server.registerTool(
    "brain_index",
    {
      description:
        "Manages the semantic index: status, build, refresh. " +
        "Call with action=status when brain_search complains the index is missing; " +
        "with action=rebuild to build it for the first time or after changing the model; " +
        "with action=sync to pull in changes (fast, new material only). " +
        "The first build on a large brain takes minutes.",
      inputSchema: {
        brainId,
        action: z
          .enum(["status", "rebuild", "sync"])
          .describe("status — look only; rebuild — build from scratch; sync — catch up."),
      },
    },
    guard(async ({ brainId: bid, action }) => {
      // The brain first, whatever the action: one request, ahead of the index
      // file. An index is a local file and can be described with no request
      // at all, which is how a brainId that names no brain was told its index
      // was not built and to rebuild it. What fails here fails the call: a
      // rebuild or a sync needs TheBrain as much, and status says nothing of
      // an index before the brain it would be the index of has answered.
      const brain = await ctx.api.brains.get(bid);
      const indexer = ctx.indexer(bid);

      if (action === "status") {
        const s = indexer.status(bid);
        // Built is a build that finished: one that failed leaves its metadata
        // and no watermark, and read as built and usable with no thought in it.
        const built = s.exists && s.syncedThrough !== null;
        // What brain_search asks of an index before it ranks by it.
        const usable = s.compatible && s.size > 0;
        const unfinished = s.exists ? "no — a build was started and did not finish" : "no";
        return ok(
          join([
            section(
              "Index status",
              bullet([
                `brain: ${brain.name ?? "(unnamed)"}`,
                `built: ${built ? "yes" : unfinished}`,
                `usable: ${usable ? "yes" : "no"}`,
                `thoughts indexed: ${s.size}`,
                `model: ${s.model ?? "—"}`,
                `synced through: ${s.syncedThrough ?? "—"}`,
              ]),
            ),
            built && usable
              ? null
              : section("What to do", "Call this tool with action=rebuild."),
          ]),
        );
      }

      const result =
        action === "rebuild" ? await indexer.rebuild(bid) : await indexer.sync(bid);

      return ok(
        join([
          section(
            action === "rebuild" ? "Index built" : "Index refreshed",
            bullet([
              `thoughts encoded: ${result.indexed}`,
              // A thought that changed kind and kept its document: the row
              // was corrected, which is neither encoded nor unchanged.
              ...(result.kindUpdated > 0
                ? [`kind updated, nothing to encode: ${result.kindUpdated}`]
                : []),
              `skipped unchanged: ${result.skipped}`,
              `removed from index: ${result.removed}`,
              `took: ${(result.elapsedMs / 1000).toFixed(1)} s`,
            ]),
          ),
        ]),
      );
    }),
  );
}

export { ThoughtKind };
