import { describe, expect, it } from "vitest";

import { ConfigError, indexPath, loadConfig } from "../src/config.js";

const KEY = { THEBRAIN_API_KEY: "test-key" };

describe("THEBRAIN_BASE_URL", () => {
  it.each([[{}], [{ THEBRAIN_BASE_URL: "" }], [{ THEBRAIN_BASE_URL: "   " }]])(
    "unset or blank leaves the address to the client: %j",
    (env) => {
      expect(loadConfig({ ...KEY, ...env }).baseUrl).toBeUndefined();
    },
  );

  it("takes the endpoint as Settings shows it", () => {
    const config = loadConfig({ ...KEY, THEBRAIN_BASE_URL: "http://localhost:11522/api/" });
    expect(config.baseUrl).toBe("http://localhost:11522");
  });
});

describe("THEBRAIN_API_KEY", () => {
  it("is required, and the error says where to find it", () => {
    expect(() => loadConfig({})).toThrowError(ConfigError);
    expect(() => loadConfig({})).toThrowError(/Local API Key/);
  });
});

describe("the path of a brain's index", () => {
  const config = loadConfig({ ...KEY, THEBRAIN_DATA_DIR: "/data" });

  it("is a file of the data directory, named by the brain", () => {
    const brainId = "aaaaaaaa-0000-4000-8000-000000000001";
    expect(indexPath(config, brainId)).toBe(`/data/index-${brainId}.sqlite`);
  });

  it.each(["my-brain", "", "x/../../elsewhere", "../aaaaaaaa-0000-4000-8000-000000000001"])(
    "is not made of a brainId that is no UUID: %j",
    (brainId) => {
      // The identifier is a tool argument, and the index is opened, and so
      // created, before any request could refuse it: "x/../../elsewhere" was
      // a file outside the data directory.
      expect(() => indexPath(config, brainId)).toThrowError(
        expect.objectContaining({ kind: "invalid_uuid" }),
      );
    },
  );
});
