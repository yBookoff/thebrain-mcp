# Choosing a stack: TypeScript vs Python

Measurements and package inspection done locally on 2026-08-11. Versions at the
time of evaluation: `@modelcontextprotocol/sdk` **1.30.0**, `fastmcp` **3.4.7**,
the official `mcp` (PyPI) **2.0.0**. Environment: Node v23.6.0, Python 3.13.1,
macOS.

The five axes below are the ones that were asked for: what the SDK provides out
of the box, runtime speed, extensibility, testability, and ease of open-source
distribution.

## 1. What the SDK provides out of the box

Verified by inspecting the installed packages, not by reading READMEs.

**`@modelcontextprotocol/sdk` 1.30.0** — the protocol is covered end to end:

- Transports: stdio, Streamable HTTP, SSE (legacy), WebSocket (client);
  middleware adapters for Express / Fastify / Hono / `node:http`
- Tools / Resources / Prompts plus `registerTool` / `registerResource` / `registerPrompt`
- Dynamics: `RegisteredTool.enable() / .disable() / .update() / .remove()` with
  automatic `listChanged` notifications
- Callbacks into the client: `createMessage` (sampling), `elicitInput`
  (elicitation), `listRoots`
- Completions (`server/completable`), logging (`sendLoggingMessage`)
- Server-side OAuth: router, handlers, `providers/`, `proxyProvider`
- `InMemoryTransport.createLinkedPair()` — for tests
- `experimental/tasks`

**FastMCP 3.4.7** — all of the same, plus a layer on top of the protocol:

| Capability | What it gives you |
|---|---|
| `add_middleware` | A request pipeline — one place for error normalisation and logging |
| `add_tool_transformation` / `wrap_transform` | Override an existing tool's schema or description without rewriting it |
| `mount` / `import_server` / `as_proxy` | Server composition and proxying |
| `from_openapi` / `from_fastapi` | Generate a server from a spec |
| `Context` | `report_progress`, `log`, `get_state`/`set_state`, `sample_step`, `elicit`, `read_resource` |
| Auth providers | 19 ready-made: github, google, azure, workos, auth0, keycloak, jwt, supabase… |
| CLI | `fastmcp install / inspect / dev / run / call / list / generate-cli / project` |
| Tasks | First-class (in TS they are `experimental/`) |
| `Client(server)` | An in-memory client built straight from the server object |

**But:** of that list, this project needs only `add_middleware`,
`add_tool_transformation`, `Context.report_progress`, the CLI, and the in-memory
client. OAuth providers are irrelevant (a Bearer key from the environment),
proxying and composition are irrelevant, and `from_openapi` is actively harmful —
it would produce 48 raw tools and put JSON Patch in the model's face.

## 2. Speed

**Cold start — measured, 5 runs each.** This matters because a stdio server
starts afresh for every client session.

| Stack | SDK import + tool registration | Whole process |
|---|---|---|
| Node + `@modelcontextprotocol/sdk` | **74–80 ms** | **0.10 s** |
| Python + `mcp.server.fastmcp` (official) | 272–390 ms | — |
| Python + `fastmcp` 3.4.7 | 461–517 ms | 0.58 s |
| Python + `fastmcp-slim[server]` | 461–488 ms | 0.57–0.73 s |

`fastmcp-slim` does not help: the weight is not in the extras but in `pydantic`
plus `mcp.types` (per `-X importtime`: `mcp` 178 ms, `mcp.client.session` 96 ms,
`pydantic_settings` 34 ms).

**Runtime — a tie.** The server is I/O-bound: a thin proxy to
`localhost:8001`. Latency is set by the TheBrain API. A concurrent
breadth-first graph traversal is equally comfortable on `Promise.all` and on
`asyncio` plus `httpx`.

## 3. Extensibility

**FastMCP is more flexible today** — middleware and tool transformation are real
levers. **TypeScript is more predictable in provenance** — it is Anthropic's
reference implementation and a thin layer.

Both carry version risk, of different kinds:

- **TS:** the repository's main branch is already **v2** targeting the 2026-07-28
  spec, while npm `latest` is 1.30.0 (v1). The major transition is in progress;
  v1.x is promised security fixes for at least six months. Migration is a
  within-the-year problem.
- **Python:** two competing SDKs — the official `mcp` 2.0 with FastMCP 1.x built
  in, versus the third-party `fastmcp` 3.4.7 (a Prefect project, not Anthropic's).

## 4. Testability

Both stacks cover the same three levels:

| Level | TS | Python |
|---|---|---|
| Unit (error normalisation, JSON Patch, brainId resolution) | vitest | pytest |
| Protocol (the whole server, no processes) | `InMemoryTransport.createLinkedPair()` | `Client(server)` — no transport at all |
| Mocking TheBrain's HTTP | msw / nock | respx / pytest-httpx |
| Contract against the live API | identical | identical |

FastMCP is one line more ergonomic. **Not a deciding difference.**

## 5. Distribution as open source

The most asymmetric axis.

- **Anthropic's own recommendation in the MCPB documentation** (Claude Desktop
  extensions): *"implement MCP servers in Node.js rather than Python to reduce
  installation friction"*.
- **Node.js ships inside Claude for macOS and Windows** — the user installs
  nothing. For Python it is either a uv runtime or a bundled venv, and the latter
  breaks on compiled dependencies — and `pydantic` is mandatory for the MCP
  Python SDK.
- **`npx` versus `uvx`:** almost everyone has Node; `uv` has to be installed
  first. TheBrain's audience is PKM users, largely not developers.
- **Install size:** 24 MB (91 packages) versus 55–70 MB (71 packages).
- **The counter-argument for Python:** `fastmcp install claude-desktop` writes the
  server into the client's config automatically. The TS SDK has no equivalent —
  that becomes instructions in the README.

## Summary

| Axis | TypeScript | Python / FastMCP | Winner |
|---|---|---|---|
| Out-of-the-box functionality | The whole protocol | Protocol plus middleware, transforms, composition, CLI, 19 auth providers | **Python** |
| Cold start | ~100 ms | ~580 ms | **TS** (5×) |
| Runtime | I/O-bound | I/O-bound | tie |
| Extensibility | thin layer, write it yourself | rich levers | **Python** |
| Testability | InMemoryTransport | `Client(server)` | tie |
| Distribution | Node built into Claude Desktop, npx, 24 MB, Anthropic's recommendation | needs uv, 55–70 MB, but has `fastmcp install` | **TS** |

## Recommendation: TypeScript

The score is 2:2 with two ties, so the decision comes down to how much each axis
weighs for **this** project.

Python's functionality advantage lands almost entirely on things this project does
not need (auth providers, proxying, composition, OpenAPI generation). The pieces
genuinely missing from TS — a middleware pipeline and tool transformation — are
replaced, for 12–15 tools, by a roughly 30-line wrapper function.

TypeScript's distribution advantage lands exactly on what is critical for an OSS
project: a TheBrain user has to be able to run the server without installing a
runtime. Plus the five-fold cold start, which is paid every time a client session
begins.

**What would flip this:** if the project were an internal tool with no outside
users, and the priority were iteration speed and rich levers, Python would be
objectively better.
