/**
 * Read tools.
 *
 * Descriptions deliberately say **when** to call a tool, not only what it
 * does: that is what drives the model's routing. They sit in context
 * permanently, so they are written tightly.
 */

import { z } from "zod";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { ThoughtKind, describeModType } from "../../api/types.js";
import { traverse } from "../../operations/traverse.js";
import { mapWithConcurrency } from "../../semantic/indexer.js";
import type { ServerContext } from "../context.js";
import { bullet, guard, join, ok, section, table } from "../respond.js";

const brainId = z
  .string()
  .describe("Brain identifier. Take it from brain_list — never guess it.");

/** Cap on how many names the log resolves: beyond this the output is unreadable anyway. */
const MAX_RESOLVED_NAMES = 60;

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
      const [brains, state] = await Promise.all([
        ctx.api.brains.list(),
        ctx.api.app.state().catch(() => null),
      ]);

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
        ]),
      );
    }),
  );

  server.registerTool(
    "brain_get_thought",
    {
      description:
        "A thought in full: note, parents, children, jumps, tags, type and attachments in one call. " +
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
        ctx.api.notes.get(bid, thoughtId).catch(() => ""),
      ]);

      const names = (list: ReadonlyArray<{ name: string | null; id: string }>): string[] =>
        list.map((t) => `${t.name ?? "(unnamed)"} — ${t.id}`);

      return ok(
        join([
          `# ${graph.thought.name ?? "(unnamed)"}\n${graph.thought.id}`,
          graph.type ? section("Type", graph.type.name ?? "") : null,
          graph.tags.length > 0
            ? section("Tags", graph.tags.map((t) => t.name ?? "").join(", "))
            : null,
          section("Parents", bullet(names(graph.parents))),
          section("Children", bullet(names(graph.children))),
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
          note.trim() === "" ? null : section("Note", note),
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
          .optional()
          .describe(
            "Other phrasings of the same concept: synonyms, a translation into the " +
              "second language, a broader and a narrower term. Three to six of them.",
          ),
        limit: z.number().int().min(1).max(50).optional().describe("Defaults to 15."),
        includeAuxiliary: z
          .boolean()
          .optional()
          .describe("Include types and tags in results. By default only ordinary thoughts."),
      },
    },
    guard(async ({ brainId: bid, query, variants, limit, includeAuxiliary }) => {
      const outcome = await ctx.search(bid).find(bid, query, {
        ...(variants !== undefined ? { variants } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(includeAuxiliary !== undefined ? { includeAuxiliary } : {}),
      });

      const rows = outcome.matches.map((m) => [
        m.score.toFixed(3),
        m.name,
        m.thoughtId,
        m.matchedVariant ?? "",
      ]);

      return ok(
        join([
          section(
            outcome.mode === "vector" ? "Found by meaning" : "Found by substring",
            table(["Score", "Thought", "Identifier", "Matched"], rows),
          ),
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
          ? `${node.name} — ${node.id}  (via ${node.path.join(" -> ")})`
          : `${node.name} — ${node.id}`;
        byDepth.set(node.depth, [...(byDepth.get(node.depth) ?? []), line]);
      }

      const root = result.nodes.find((n) => n.depth === 0);
      const labelled = result.edges.filter((e) => e.name !== null);

      return ok(
        join([
          `# Neighbourhood of: ${root?.name ?? thoughtId}`,
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
          section(
            "Totals",
            `thoughts ${result.nodes.length}, links ${result.edges.length}` +
              (result.truncated ? " (traversal hit the limit, there is more)" : ""),
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
          .describe("ISO timestamp to start from. Defaults to the last seven days."),
        limit: z.number().int().min(1).max(500).optional().describe("Defaults to 100."),
      },
    },
    guard(async ({ brainId: bid, since, limit }) => {
      const from = since ?? new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
      const logs = await ctx.api.brains.modifications(bid, {
        since: from,
        maxLogs: limit ?? 100,
      });

      // Names are resolved in one bounded batch: otherwise a large `limit`
      // turns into hundreds of sequential requests.
      const unique = [
        ...new Set(logs.filter((l) => l.sourceType === 2).map((l) => l.sourceId)),
      ].slice(0, MAX_RESOLVED_NAMES);
      const resolved = await mapWithConcurrency(unique, 10, async (id) => {
        const t = await ctx.api.thoughts.get(bid, id).catch(() => null);
        return [id, t?.name ?? "(unnamed)"] as const;
      });
      const thoughtNames = new Map(resolved);

      const rows = logs
        .slice()
        .sort((a, b) => b.creationDateTime.localeCompare(a.creationDateTime))
        .map((l) => [
          l.creationDateTime.slice(0, 16).replace("T", " "),
          describeModType(l.modType),
          l.sourceType === 2
            ? (thoughtNames.get(l.sourceId) ?? "(deleted or not shown)")
            : "",
        ]);

      return ok(
        join([
          section(
            `Changes since ${from.slice(0, 16).replace("T", " ")}`,
            table(["When", "What", "Thought"], rows),
          ),
          section("Totals", `events ${logs.length}`),
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
      const indexer = ctx.indexer(bid);

      if (action === "status") {
        const s = indexer.status(bid);
        return ok(
          join([
            section(
              "Index status",
              bullet([
                `built: ${s.exists ? "yes" : "no"}`,
                `usable: ${s.compatible ? "yes" : "no"}`,
                `thoughts indexed: ${s.size}`,
                `model: ${s.model ?? "—"}`,
                `synced through: ${s.syncedThrough ?? "—"}`,
              ]),
            ),
            s.compatible ? null : section("What to do", "Call this tool with action=rebuild."),
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
