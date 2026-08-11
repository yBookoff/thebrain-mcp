# thebrain-mcp

An MCP server for [TheBrain 15](https://www.thebrain.com/), built on its local API.

It gives an agent semantic operations over your brain: search by meaning, read a
neighbourhood of the graph, and write a decomposed piece of material into the
brain as a whole connected structure. It is not a mirror of the API — 17 tools
instead of 48 endpoints.

The point is not "save this text". The point is that when you hand an agent an
article, it reads it, breaks it into meanings, works out where each one belongs
in the graph you already have, what to link it to, and what each note should say.

> Published on npm as **`thebrain-mcp-server`** — npm considers the shorter name
> too close to an unrelated existing package. The installed command is still
> `thebrain-mcp`.

## Requirements

- TheBrain 15 running, with the local API enabled
- Node.js 22 or newer
- An API key: **Settings → User → Local API Key**

## Install

### Claude Code

```
claude mcp add thebrain -e THEBRAIN_API_KEY=your-key -- npx -y thebrain-mcp-server
```

### Clients with a config file

```json
{
  "mcpServers": {
    "thebrain": {
      "command": "npx",
      "args": ["-y", "thebrain-mcp-server"],
      "env": { "THEBRAIN_API_KEY": "your-key" }
    }
  }
}
```

## Semantic search

TheBrain's own search matches prefixes: `OT` finds `OTGP`, while a synonym or a
typo finds nothing. To search by meaning, the server builds a local vector index.

The embeddings package is **not part of the install**: it weighs around 380 MB,
plus 113 MB for the model itself on first run. Install it separately, and only if
you want it:

```
npm install -g @huggingface/transformers
```

Then, from your client: `brain_index` with `action: "rebuild"`. Indexing a
10,000-thought brain takes about a minute; later runs only recompute what changed.

**The server works without the package.** `brain_search` falls back to a fan-out
of prefix queries over the synonyms the agent supplies, and says plainly that
recall is lower.

Everything is local: neither your brain's contents nor your queries are sent
anywhere.

## Settings

| Variable | Default | Purpose |
|---|---|---|
| `THEBRAIN_API_KEY` | — | Required |
| `THEBRAIN_BASE_URL` | `http://localhost:8001` | Local API address |
| `THEBRAIN_DATA_DIR` | `~/.thebrain-mcp` | Where indexes are stored |
| `THEBRAIN_ALLOW_DESTRUCTIVE` | `0` | Allow deleting thoughts |
| `THEBRAIN_EMBEDDING_MODEL` | `Xenova/multilingual-e5-small` | Embedding model |
| `THEBRAIN_EMBEDDING_DTYPE` | `q8` | Weight precision |
| `THEBRAIN_TIMEOUT_MS` | `30000` | API request timeout |

Changing the model or the precision makes an existing index unusable — the server
will say so and ask for a rebuild.

## Tools

**Reading**

| Tool | What it does |
|---|---|
| `brain_list` | Brains, which one is open, whether the index is ready |
| `brain_get_thought` | A thought, its graph and its note in one call |
| `brain_search` | Search by meaning |
| `brain_traverse` | Walk the graph several hops out |
| `brain_list_types_and_tags` | The brain's vocabulary |
| `brain_recent_changes` | What changed, in plain language |
| `brain_index` | Index status, build and refresh |

**Writing**

| Tool | What it does |
|---|---|
| `brain_create_thought` | A thought together with its note, type and tags |
| `brain_update_thought` | Name, label, type, colours |
| `brain_set_note` / `brain_append_note` | Replace or extend a note |
| `brain_link` | Connect two thoughts, with a label |
| `brain_tag` | Attach and detach tags |
| `brain_attach_url` | Attach a link, without duplicates |
| `brain_activate` | Open a thought on the user's screen |
| `brain_delete_thought` | Delete, with human confirmation |
| `brain_ingest` | Write a whole structure in one call |

### `brain_ingest`

The main tool for filling a brain. The agent breaks material into thoughts, wires
them together through temporary identifiers, and the whole thing lands in one call:

```json
{
  "brainId": "…",
  "thoughts": [
    { "tempId": "art",   "name": "Article on RAG", "parent": "<uuid of an existing thought>" },
    { "tempId": "embed", "name": "Embeddings", "parent": "art", "note": "…" },
    { "tempId": "store", "name": "Vector store", "parent": "art" }
  ],
  "links": [
    { "from": "embed", "to": "store", "name": "is written into" }
  ]
}
```

The order of thoughts in the input does not matter — dependencies resolve
themselves. Running the same plan twice duplicates nothing. Bad plans (a cycle, a
reference to nowhere) are rejected **before** the first write.

## Skills

The server provides the mechanism — deterministic operations. The methodology
(how finely to split meanings, when to attach to something that already exists,
what belongs in a note) lives separately, in Claude Code skills. They are plain
markdown files, so you can adjust them to your own way of working without
rebuilding the server.

| Skill | When it fires |
|---|---|
| `thebrain-ingest` | "put this article in my brain", "break this down and record it" |
| `thebrain-research` | "what do I know about X", "have we discussed this already?" |
| `thebrain-organize` | "clean up my brain", "find duplicates" |
| `thebrain-digest` | "what did I add this week", "what have I been working on" |

Install them as symlinks, so edits in the repository take effect immediately:

```bash
mkdir -p ~/.claude/skills
for d in skills/*/; do
  ln -sfn "$PWD/$d" ~/.claude/skills/"$(basename "$d")"
done
```

Or copy them, if you do not want the link to the repository. For a single
project, use `.claude/skills` in its root instead of `~/.claude/skills`.

Skills are picked up when a session starts — an already running session needs a
restart (`claude --continue` keeps the conversation).

## Deletion

Off by default. Even with `THEBRAIN_ALLOW_DESTRUCTIVE=1` it requires human
consent: through a confirmation form if the client supports one, otherwise
through a second call with an explicit flag. The agent cannot make this decision
for you.

## Development

```
npm install
npm test                 # unit tests, no live TheBrain needed
npm run build
```

Contract tests against a live API:

```
THEBRAIN_API_KEY=… npm test                                  # read-only
THEBRAIN_API_KEY=… THEBRAIN_TEST_BRAIN_ID=<uuid> npm test    # + writes
```

The write tests require a **separate, throwaway brain** and refuse to touch any
brain with more than 500 thoughts.

## Documentation

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — how the server is built and why: layer
  boundaries, the mechanism/policy split, error philosophy, the semantic layer,
  and the measurements behind each decision.
- [`docs/api-map.md`](docs/api-map.md) — the local API's behaviour, including the
  undocumented parts, verified against a live instance.
- [`docs/stack-evaluation.md`](docs/stack-evaluation.md) — why TypeScript, with
  numbers.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — how to work on this.

## License

MIT
