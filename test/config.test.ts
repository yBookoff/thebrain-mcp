import { describe, expect, it } from "vitest";

import { ConfigError, loadConfig } from "../src/config.js";

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
