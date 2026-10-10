/**
 * Configuration from environment variables.
 *
 * MCP clients launch the server as a process and pass settings this way only:
 * a typical install has neither arguments nor a config file.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { assertUuid, normalizeBaseUrl } from "./api/client.js";

export interface Config {
  apiKey: string;
  /** Address of the local API. Unset: the client tries the ports it knows. */
  baseUrl: string | undefined;
  /** Directory for indexes. One file per brain. */
  dataDir: string;
  /** Embedding model; changing it invalidates any existing index. */
  embeddingModel: string;
  embeddingDtype: "fp32" | "fp16" | "q8" | "q4";
  /** Allow deleting thoughts, links and attachments. */
  allowDestructive: boolean;
  requestTimeoutMs: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const VALID_DTYPES = new Set(["fp32", "fp16", "q8", "q4"]);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiKey = env["THEBRAIN_API_KEY"]?.trim();
  if (!apiKey) {
    throw new ConfigError(
      "THEBRAIN_API_KEY is not set. Find the key in the desktop app under " +
        "Settings > User > Local API Key",
    );
  }

  const baseUrl = env["THEBRAIN_BASE_URL"]?.trim();

  const dtype = (env["THEBRAIN_EMBEDDING_DTYPE"] ?? "q8").trim();
  if (!VALID_DTYPES.has(dtype)) {
    throw new ConfigError(
      `THEBRAIN_EMBEDDING_DTYPE must be one of ${[...VALID_DTYPES].join(", ")}, ` +
        `got ${JSON.stringify(dtype)}`,
    );
  }

  return {
    apiKey,
    baseUrl: baseUrl ? normalizeBaseUrl(baseUrl) : undefined,
    dataDir: env["THEBRAIN_DATA_DIR"] ?? join(homedir(), ".thebrain-mcp"),
    embeddingModel: env["THEBRAIN_EMBEDDING_MODEL"] ?? "Xenova/multilingual-e5-small",
    embeddingDtype: dtype as Config["embeddingDtype"],
    allowDestructive: parseBoolean(env["THEBRAIN_ALLOW_DESTRUCTIVE"]) ?? false,
    requestTimeoutMs: parseNumber(env["THEBRAIN_TIMEOUT_MS"]) ?? 30_000,
  };
}

/**
 * Path to a specific brain's index. Throws `invalid_uuid` for a `brainId`
 * that is not a UUID.
 *
 * The identifier is a tool argument, and it goes into a file name: the index
 * is opened, and so created, before any request has had the chance to refuse
 * it. `brain_index` with `action: "status"` made `index-my-brain.sqlite` for
 * `my-brain`, and for `x/../../name` a file outside the data directory.
 */
export function indexPath(config: Config, brainId: string): string {
  assertUuid(brainId, "brainId");
  return join(config.dataDir, `index-${brainId}.sqlite`);
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const v = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off", ""].includes(v)) return false;
  return undefined;
}

function parseNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
