/**
 * Breadth-first graph traversal.
 *
 * The API offers nothing deeper than one hop: `graph` returns immediate
 * neighbours only. Traversal is assembled from many such requests — the API
 * answers in about 10 ms and handles concurrency comfortably.
 */

import type { TheBrainApi } from "../api/index.js";
import type { ThoughtDto } from "../api/types.js";
import { mapWithConcurrency } from "../semantic/indexer.js";

export type EdgeKind = "child" | "parent" | "jump";

export interface TraverseNode {
  id: string;
  name: string;
  kind: number;
  /** Distance from the starting thought, in hops. */
  depth: number;
  /** How we got here: the path of names from the starting thought. */
  path: string[];
}

export interface TraverseEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  name: string | null;
}

export interface TraverseResult {
  nodes: TraverseNode[];
  edges: TraverseEdge[];
  /** Traversal stopped at the limit rather than exhausting the graph. */
  truncated: boolean;
}

export interface TraverseOptions {
  depth?: number;
  /** Which edges to follow. All three kinds by default. */
  follow?: readonly EdgeKind[];
  /** Safety valve: on a well-connected brain traversal grows fast. */
  maxNodes?: number;
  concurrency?: number;
}

const DEFAULT_DEPTH = 2;
const DEFAULT_MAX_NODES = 150;

export async function traverse(
  api: TheBrainApi,
  brainId: string,
  rootId: string,
  options: TraverseOptions = {},
): Promise<TraverseResult> {
  const depth = Math.max(1, options.depth ?? DEFAULT_DEPTH);
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  const follow = new Set<EdgeKind>(options.follow ?? ["child", "parent", "jump"]);
  const concurrency = options.concurrency ?? 8;

  const nodes = new Map<string, TraverseNode>();
  const edges: TraverseEdge[] = [];
  const seenEdges = new Set<string>();
  let truncated = false;

  const root = await api.thoughts.getGraph(brainId, rootId);
  nodes.set(rootId, {
    id: rootId,
    name: root.thought.name ?? "",
    kind: root.thought.kind,
    depth: 0,
    path: [],
  });

  let frontier: string[] = [rootId];
  const expanded = new Map<string, Awaited<ReturnType<typeof api.thoughts.getGraph>>>([
    [rootId, root],
  ]);

  for (let level = 0; level < depth; level += 1) {
    const graphs = await mapWithConcurrency(frontier, concurrency, async (id) => {
      const cached = expanded.get(id);
      if (cached !== undefined) return { id, graph: cached };
      const graph = await api.thoughts.getGraph(brainId, id).catch(() => null);
      return { id, graph };
    });

    const next: string[] = [];
    for (const { id, graph } of graphs) {
      if (graph === null) continue;
      const parent = nodes.get(id)!;

      const groups: Array<[EdgeKind, ThoughtDto[]]> = [
        ["child", graph.children],
        ["parent", graph.parents],
        ["jump", graph.jumps],
      ];

      for (const [kind, list] of groups) {
        if (!follow.has(kind)) continue;
        for (const neighbour of list) {
          const edgeKey = `${id}>${neighbour.id}:${kind}`;
          if (!seenEdges.has(edgeKey)) {
            seenEdges.add(edgeKey);
            edges.push({
              from: id,
              to: neighbour.id,
              kind,
              name: linkNameBetween(graph.links, id, neighbour.id),
            });
          }
          if (nodes.has(neighbour.id)) continue;
          if (nodes.size >= maxNodes) {
            truncated = true;
            continue;
          }
          nodes.set(neighbour.id, {
            id: neighbour.id,
            name: neighbour.name ?? "",
            kind: neighbour.kind,
            depth: level + 1,
            path: [...parent.path, parent.name],
          });
          next.push(neighbour.id);
        }
      }
    }

    if (next.length === 0) break;
    frontier = next;
  }

  return { nodes: [...nodes.values()], edges, truncated };
}

function linkNameBetween(
  links: ReadonlyArray<{ thoughtIdA: string; thoughtIdB: string; name: string | null }>,
  a: string,
  b: string,
): string | null {
  for (const link of links) {
    const matches =
      (link.thoughtIdA === a && link.thoughtIdB === b) ||
      (link.thoughtIdA === b && link.thoughtIdB === a);
    if (matches && link.name) return link.name;
  }
  return null;
}
