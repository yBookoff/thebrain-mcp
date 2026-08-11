import { describe, expect, it, vi } from "vitest";

import { TheBrainError } from "../src/api/index.js";
import { EmbedderUnavailableError } from "../src/semantic/embedder.js";
import { confirmDestructive, confirmationInstructions } from "../src/server/confirm.js";
import {
  bullet,
  describeError,
  fail,
  guard,
  join,
  ok,
  section,
  table,
} from "../src/server/respond.js";

describe("response shape", () => {
  it("success is not flagged as an error", () => {
    expect(ok("done")).toEqual({ content: [{ type: "text", text: "done" }] });
  });

  it("an error is flagged isError rather than thrown outward", () => {
    expect(fail("bad")).toEqual({
      content: [{ type: "text", text: "bad" }],
      isError: true,
    });
  });

  it("guard turns an exception into isError", async () => {
    const handler = guard(async () => {
      throw new TheBrainError("auth", "no key");
    });
    const result = await handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/THEBRAIN_API_KEY/);
  });

  it("guard passes a successful result through untouched", async () => {
    const handler = guard(async () => ok("all good"));
    await expect(handler({})).resolves.toEqual(ok("all good"));
  });
});

describe("error explanations point at the next step", () => {
  it("a malformed UUID points at the tools that provide one", () => {
    const text = describeError(
      new TheBrainError("invalid_uuid", "thoughtId must be a UUID"),
    );
    expect(text).toMatch(/brain_list/);
    expect(text).toMatch(/do not invent/);
  });

  it("a key problem says where to find the key", () => {
    expect(describeError(new TheBrainError("auth", "Invalid API Key"))).toMatch(
      /Settings > User > Local API Key/,
    );
  });

  it("a network failure suggests checking the app", () => {
    expect(describeError(new TheBrainError("network", "no connection"))).toMatch(
      /TheBrain desktop app is running/,
    );
  });

  it("a router miss is explained in human terms, not as \"HTML arrived\"", () => {
    expect(describeError(new TheBrainError("route_miss", "html"))).toMatch(
      /not found or is malformed/,
    );
  });

  it("403 on the local API is explained as a missing object", () => {
    expect(describeError(new TheBrainError("forbidden", "denied"))).toMatch(
      /exists in this brain/,
    );
  });

  it("the missing-embeddings-package message passes through verbatim", () => {
    expect(describeError(new EmbedderUnavailableError())).toMatch(/380 MB/);
  });

  it("an ordinary error keeps its message", () => {
    expect(describeError(new Error("something went wrong"))).toBe("something went wrong");
  });

  it("a non-error is coerced to a string", () => {
    expect(describeError("a string")).toBe("a string");
  });
});

describe("formatting", () => {
  it("the table aligns columns", () => {
    const out = table(["Name", "Id"], [["short", "1"], ["considerably longer", "2"]]);
    const lines = out.split("\n");
    expect(lines[0]).toMatch(/^Name/);
    expect(lines[1]).toMatch(/^─+/);
    expect(lines).toHaveLength(4);
  });

  it("an empty table draws no header", () => {
    expect(table(["a", "b"], [])).toBe("(empty)");
  });

  it("a list with no items is marked empty", () => {
    expect(bullet([])).toBe("(empty)");
  });

  it("empty sections drop out instead of leaving a heading", () => {
    expect(section("Heading", "")).toBeNull();
    expect(section("Heading", "(empty)")).toBeNull();
    expect(section("Heading", "body")).toBe("## Heading\nbody");
  });

  it("join drops empty parts", () => {
    expect(join(["first", null, "second"])).toBe("first\n\nsecond");
  });
});

describe("confirming irreversible operations", () => {
  const serverWith = (capabilities: unknown, elicit?: unknown) =>
    ({
      server: {
        getClientCapabilities: () => capabilities,
        elicitInput: elicit,
      },
    }) as never;

  it("an explicit confirmation flag is accepted without a dialog", async () => {
    const elicit = vi.fn();
    const outcome = await confirmDestructive(
      serverWith({ elicitation: {} }, elicit),
      "delete?",
      true,
    );
    expect(outcome).toEqual({ granted: true });
    expect(elicit).not.toHaveBeenCalled();
  });

  it("a client without elicitation is sent back for an explicit flag", async () => {
    const outcome = await confirmDestructive(serverWith({}), "delete?", false);
    expect(outcome).toEqual({ granted: false, reason: "needs-explicit-flag" });
  });

  it("user consent through the form authorises the operation", async () => {
    const elicit = vi.fn(async () => ({ action: "accept", content: { confirm: true } }));
    const outcome = await confirmDestructive(
      serverWith({ elicitation: {} }, elicit),
      "delete?",
      false,
    );
    expect(outcome).toEqual({ granted: true });
  });

  it("a user refusal blocks the operation", async () => {
    const elicit = vi.fn(async () => ({ action: "decline" }));
    const outcome = await confirmDestructive(
      serverWith({ elicitation: {} }, elicit),
      "delete?",
      false,
    );
    expect(outcome).toEqual({ granted: false, reason: "declined" });
  });

  it("form shown but the box left unchecked counts as a refusal", async () => {
    const elicit = vi.fn(async () => ({ action: "accept", content: { confirm: false } }));
    const outcome = await confirmDestructive(
      serverWith({ elicitation: {} }, elicit),
      "delete?",
      false,
    );
    expect(outcome).toEqual({ granted: false, reason: "declined" });
  });

  it("an elicitation failure does not lead to a silent deletion", async () => {
    const elicit = vi.fn(async () => {
      throw new Error("client dropped");
    });
    const outcome = await confirmDestructive(
      serverWith({ elicitation: {} }, elicit),
      "delete?",
      false,
    );
    expect(outcome.granted).toBe(false);
  });

  it("the refusal instruction differs from the unsupported-client one", () => {
    expect(confirmationInstructions("summary", "declined")).toMatch(/cancelled by the user/);
    expect(confirmationInstructions("summary", "needs-explicit-flag")).toMatch(
      /confirm=true/,
    );
  });
});
