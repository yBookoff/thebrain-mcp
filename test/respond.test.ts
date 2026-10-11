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
  kindLabel,
  kindMark,
  ok,
  section,
  table,
} from "../src/server/respond.js";
import { describeAliasOutcome } from "../src/server/tools/write.js";

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

  it("a typeId that is not a type points at the list of types, and says nothing was written", () => {
    const text = describeError(
      new TheBrainError("not_a_type", 'typeId 1f0e is not a type: it is the tag "gotcha"'),
    );
    expect(text).toMatch(/is not a type: it is the tag "gotcha"\./);
    expect(text).toMatch(/Nothing was written/);
    expect(text).toMatch(/brain_list_types_and_tags/);
  });

  it("an identifier that is not a tag points at the list of tags, and says nothing was written", () => {
    const text = describeError(
      new TheBrainError("not_a_tag", 'tagId 1f0e is not a tag: it is the type "Pattern"'),
    );
    expect(text).toMatch(/is not a tag: it is the type "Pattern"\./);
    expect(text).toMatch(/Nothing was written/);
    expect(text).toMatch(/Take tag identifiers from brain_list_types_and_tags/);
  });

  it("a type named as a parent says what that link would do, and both ways out", () => {
    const text = describeError(
      new TheBrainError("not_a_parent", 'toId 1f0e cannot be a parent: it is the type "Pattern"'),
    );
    expect(text).toMatch(/cannot be a parent: it is the type "Pattern"\./);
    expect(text).toMatch(/Nothing was written/);
    expect(text).toMatch(/given that type in place of the one it had/);
    expect(text).toMatch(/typeId to brain_update_thought or brain_create_thought/);
    expect(text).toMatch(/for a parent name an ordinary thought/);
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
    const text = describeError(new TheBrainError("route_miss", "html"));
    expect(text).toMatch(/identifier in the request is malformed/);
    // Measured: an identifier nobody has never gets the app's page.
    expect(text).not.toMatch(/not found/);
  });

  const BRAIN = "aaaaaaaa-0000-4000-8000-000000000001";
  const NOBODY = "99999999-0000-4000-8000-000000000009";
  const ROUTER_403 =
    "To use the TheBrain API, make requests to /api (e.g. /api/brains). " +
    "An API key is required via the Authorization header.";
  const answered = (
    kind: "unknown_brain" | "not_found" | "forbidden",
    message: string,
    method: string,
    path: string,
  ): string => describeError(new TheBrainError(kind, message, { method, path }));

  it("a brainId that is no brain is explained as that, not as a rejected key", () => {
    // The API answers 401 to both, in different words.
    const text = answered(
      "unknown_brain",
      `Access to brain ${BRAIN} is unauthorized.`,
      "GET",
      `/api/thoughts/${BRAIN}/${NOBODY}/graph`,
    );
    expect(text).toBe(
      `Access to brain ${BRAIN} is unauthorized. The key was accepted: it is brainId that ` +
        "names no brain open to it. Take brainId from brain_list. The other identifiers " +
        "in the call were not looked at.",
    );
    expect(text).not.toMatch(/THEBRAIN_API_KEY|Settings/);
    // Nor as a wrong thought identifier: every request to such a brain is this 401.
    expect(text).not.toMatch(/brain_search|brain_get_thought|deleted/);
  });

  it("a 404 that names what it did not find keeps the API's words", () => {
    // A create under a parent nobody has, and a URL attached to a thought nobody has.
    expect(
      answered(
        "not_found",
        `Source Thought ${NOBODY} could not be located`,
        "POST",
        `/api/thoughts/${BRAIN}`,
      ),
    ).toBe(
      `Source Thought ${NOBODY} could not be located. It may have been deleted, or be ` +
        "another brain's. Take identifiers from brain_search or brain_get_thought.",
    );
    expect(
      answered(
        "not_found",
        `Thought \`${NOBODY}\` not found.`,
        "POST",
        `/api/attachments/${BRAIN}/${NOBODY}/url`,
      ),
    ).toMatch(new RegExp(`^Thought \`${NOBODY}\` not found\\. It may have been deleted`));
  });

  it("a bare 404 names what the path addressed, by its identifier", () => {
    // A read and a patch of a thought or a link nobody has say only "Not Found".
    const thought = answered("not_found", "Not Found", "PATCH", `/api/thoughts/${BRAIN}/${NOBODY}`);
    expect(thought).toBe(
      `No thought in this brain has the identifier ${NOBODY} ` +
        `(PATCH /api/thoughts/${BRAIN}/${NOBODY}). It may have been deleted, or be another ` +
        "brain's. Take identifiers from brain_search or brain_get_thought.",
    );
    expect(answered("not_found", "Not Found", "GET", `/api/links/${BRAIN}/${NOBODY}`)).toMatch(
      new RegExp(`^No link in this brain has the identifier ${NOBODY} \\(GET `),
    );
    // Two identifiers, or one that is not the thing's own: no guess is made.
    for (const path of [
      `/api/links/${BRAIN}/${NOBODY}/${BRAIN}`,
      `/api/attachments/${BRAIN}/${NOBODY}/metadata`,
    ]) {
      expect(answered("not_found", "Not Found", "GET", path)).toMatch(
        new RegExp(`^Not found \\(GET ${path}\\)\\. It may have been deleted`),
      );
    }
  });

  it("the catch-all 403 is not called a matter of access, and names the request", () => {
    // What the graph of a thought nobody has answers. The old text began "Access denied".
    const text = answered("forbidden", ROUTER_403, "GET", `/api/thoughts/${BRAIN}/${NOBODY}/graph`);
    expect(text).toBe(
      "TheBrain answered 403 and named no cause " +
        `(GET /api/thoughts/${BRAIN}/${NOBODY}/graph). That is its answer when an identifier ` +
        "in the call names nothing in this brain. It may have been deleted, or be another " +
        "brain's. Take identifiers from brain_search or brain_get_thought.",
    );
    expect(text).not.toMatch(/denied|API key/i);
  });

  it("the 403 a note's read gets is not explained as an identifier that names nothing", () => {
    // Measured: the note of a thought nobody has is a 200 that says "no
    // note", and the read answers the 403 for a moment after the note's
    // attachment is deleted, on a thought that is there.
    const note = `/api/notes/${BRAIN}/${NOBODY}`;
    const text = answered("forbidden", ROUTER_403, "GET", note);
    expect(text).toBe(
      `TheBrain answered 403 and named no cause (GET ${note}). The read of a note gets that ` +
        "answer for a moment after the note is deleted, and it says nothing of the thought " +
        "or of its identifier.",
    );
    expect(text).not.toMatch(/names nothing|deleted, or be another|Take identifiers/);
    // Only that read. A write to a note has not been seen to answer it, and
    // is explained as any other request is.
    for (const [method, path] of [
      ["POST", `${note}/update`],
      ["POST", `${note}/append`],
      ["GET", `/api/thoughts/${BRAIN}/${NOBODY}/graph`],
    ] as const) {
      expect(answered("forbidden", ROUTER_403, method, path), path).toMatch(
        /That is its answer when an identifier in the call names nothing in this brain/,
      );
    }
  });

  it("an identifier nobody has is never explained as a wrong brainId or a wrong key", () => {
    for (const text of [
      answered("not_found", "Not Found", "GET", `/api/thoughts/${BRAIN}/${NOBODY}`),
      answered("not_found", `Source Thought ${NOBODY} could not be located`, "POST", "/api/t"),
      answered("forbidden", ROUTER_403, "GET", `/api/thoughts/${BRAIN}/${NOBODY}/graph`),
    ]) {
      expect(text).not.toMatch(/brainId|brain_list\b|THEBRAIN_API_KEY/);
    }
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

  it("the 400 a create gives with no cause says what it answers so for, and what to read", () => {
    // Measured: a create under a parent deleted a moment ago, and one with a
    // typeId nobody has. Neither makes a thought. It used to be passed on as
    // it came, "Could not create thought. (POST …)".
    const refused = (message: string, path: string): string =>
      describeError(new TheBrainError("bad_request", message, { status: 400, method: "POST", path }));
    const text = refused("Could not create thought.", `/api/thoughts/${BRAIN}`);
    expect(text).toBe(
      `Could not create thought. TheBrain named no cause (POST /api/thoughts/${BRAIN}). It ` +
        "answers so when the parent named for the new thought was deleted a moment ago, or " +
        "the type named for it is no thought of this brain. Nothing was created. Read the " +
        "parent and the type with brain_get_thought before sending the call again.",
    );
    // It names no identifier, so it names both it can be about, and no other.
    expect(text).not.toMatch(/brainId|brain_list\b|THEBRAIN_API_KEY/);

    // A 400 that says what it is about is passed on with its request, as before.
    expect(refused(`Could not get target thought ${NOBODY}`, `/api/links/${BRAIN}`)).toBe(
      `Could not get target thought ${NOBODY} (POST /api/links/${BRAIN})`,
    );
  });

  it("a refusal met after the call has written does not say that nothing was written", () => {
    // True of the step that was refused, and it would be read of the call:
    // brain_create_thought said it over a thought it had just made.
    for (const kind of ["not_a_type", "not_a_tag", "not_a_parent", "tag_as_parent"] as const) {
      const error = new TheBrainError(kind, "1f0e is not one");
      expect(describeError(error), kind).toContain("1f0e is not one. Nothing was written. ");
      expect(describeError(error, false), kind).toBe(
        describeError(error).replace(" Nothing was written.", ""),
      );
    }
    // No other explanation makes that claim, and each reads the same either way.
    for (const error of [
      new TheBrainError("network", "no connection"),
      new TheBrainError("not_found", "Not Found", {
        method: "PATCH",
        path: `/api/thoughts/${BRAIN}/${NOBODY}`,
      }),
      new TheBrainError("forbidden", ROUTER_403, { method: "GET", path: "/api/t" }),
      new TheBrainError("server", "boom", { method: "POST", path: "/api/t" }),
      // A 5xx, whose line says to check what a write left: as true of a step.
      new TheBrainError("server", "boom", { status: 500, method: "POST", path: "/api/t" }),
      new TheBrainError("query_too_long", "the query is too long"),
      new Error("something went wrong"),
    ]) {
      expect(describeError(error, false)).toBe(describeError(error));
      expect(describeError(error)).not.toMatch(/Nothing was written/);
    }
  });
});

describe("a failure that is TheBrain's own, and a query it will not take", () => {
  const BRAIN = "aaaaaaaa-0000-4000-8000-000000000001";
  const at = { method: "GET", path: `/api/search/${BRAIN}` };

  it("a 5xx is told with its status, as a fault of the app and not of the call", () => {
    // It was the body and the request: "Internal Server Error (GET …)".
    const text = describeError(
      new TheBrainError("server", "Internal Server Error", { status: 500, ...at }),
    );
    expect(text).toBe(
      `TheBrain failed with a 500 (GET /api/search/${BRAIN}): Internal Server Error. ` +
        "The fault is inside the app, not in the arguments of this call. A read is safe to " +
        "repeat; before repeating a write, check what it left.",
    );
  });

  it("a 5xx with no body still says which status it was", () => {
    // It was "(empty response) (GET …)", with nothing to tell it from a 400.
    const text = describeError(
      new TheBrainError("server", "(empty response)", { status: 503, ...at }),
    );
    expect(text).toContain(
      `TheBrain failed with a 503 (GET /api/search/${BRAIN}): (empty response). The fault `,
    );
  });

  it("a sentence of this server's own under that kind is left whole", () => {
    // thoughts.update() raises one with no status when a type does not read back.
    const own = "the type was accepted, but the thought does not read back with it yet";
    expect(describeError(new TheBrainError("server", own))).toBe(own);
  });

  it("a query too long is told in the resource's words, and as a sentence", () => {
    const text = describeError(
      new TheBrainError("query_too_long", "the search text is 600 words. Shorten it", {
        status: 403,
        ...at,
      }),
    );
    expect(text).toBe("the search text is 600 words. Shorten it.");
    // The 403 it was made from is explained as an identifier nobody has.
    expect(text).not.toMatch(/identifier|brain_get_thought/);
  });

  it("a request that timed out reads as two sentences", () => {
    // "request exceeded 30000 ms Check that…"
    expect(describeError(new TheBrainError("network", "request exceeded 30000 ms"))).toBe(
      "request exceeded 30000 ms. Check that the TheBrain desktop app is running and its " +
        "local API is enabled.",
    );
    const refused = "could not reach http://localhost:11522 — is TheBrain running?";
    expect(describeError(new TheBrainError("network", refused))).toBe(
      "could not reach http://localhost:11522 — is TheBrain running? Check that the " +
        "TheBrain desktop app is running and its local API is enabled.",
    );
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

describe("what kind of thought a result names", () => {
  it("an ordinary thought has no label and no mark, so it costs nothing", () => {
    expect(kindLabel(1)).toBeNull();
    expect(kindMark(1)).toBe("");
  });

  it("a type and a tag are named", () => {
    expect(kindLabel(2)).toBe("type");
    expect(kindLabel(4)).toBe("tag");
    expect(kindMark(2)).toBe(" [type]");
    expect(kindMark(4)).toBe(" [tag]");
  });

  it("a kind with no name here is shown as the API's number, not passed off as ordinary", () => {
    expect(kindLabel(3)).toBe("kind 3");
    expect(kindMark(5)).toBe(" [kind 5]");
  });

  it("a thought read with no kind at all is taken for an ordinary one", () => {
    expect(kindMark(undefined as unknown as number)).toBe("");
    expect(kindMark(null as unknown as number)).toBe("");
  });
});

describe("reporting an alias edit", () => {
  it("says what was added and removed, and what the list is now", () => {
    expect(
      describeAliasOutcome({
        aliases: ["b", "c"],
        added: ["c"],
        removed: ["a"],
        readBack: true,
      }),
    ).toEqual(['aliases added: ["c"]', 'aliases removed: ["a"]', 'aliases now: ["b","c"]']);
  });

  it("an edit with nothing to do says so instead of claiming a change", () => {
    const lines = describeAliasOutcome({ aliases: ["b"], added: [], removed: [], readBack: true });
    expect(lines[0]).toMatch(/unchanged/);
    expect(lines.at(-1)).toBe('aliases now: ["b"]');
  });

  it("a write that does not read back yet warns against editing again", () => {
    const lines = describeAliasOutcome({
      aliases: ["b"],
      added: ["b"],
      removed: [],
      readBack: false,
    });
    expect(lines.at(-1)).toMatch(/do not read back yet.*brain_get_thought/);
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
