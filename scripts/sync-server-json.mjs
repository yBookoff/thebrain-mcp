/**
 * Keeps server.json in step with package.json.
 *
 * The MCP Registry entry carries its own version, in two places, and both must
 * match what was published to npm — a stale one either fails validation or,
 * worse, points users at a version that no longer exists. Rather than trusting
 * anyone to remember, `npm version` runs this through its `version` lifecycle
 * hook and stages the result into the release commit.
 *
 * Run with --check to verify instead of rewrite; the publish workflow uses that
 * so a hand-edited mismatch cannot reach the registry.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkgPath = join(root, "package.json");
const serverPath = join(root, "server.json");

const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const server = JSON.parse(readFileSync(serverPath, "utf8"));
const checkOnly = process.argv.includes("--check");

const problems = [];

if (server.name !== pkg.mcpName) {
  problems.push(
    `server.json name (${server.name}) must equal package.json mcpName (${pkg.mcpName})`,
  );
}

const npmPackage = server.packages?.find((p) => p.registryType === "npm");
if (npmPackage === undefined) {
  problems.push("server.json has no npm package entry");
} else if (npmPackage.identifier !== pkg.name) {
  problems.push(
    `server.json identifier (${npmPackage.identifier}) must equal package.json name (${pkg.name})`,
  );
}

// Identity mismatches are never safe to fix automatically: they mean someone
// renamed something and only half the rename landed.
if (problems.length > 0) {
  console.error(problems.map((p) => `  ${p}`).join("\n"));
  process.exit(1);
}

const stale = server.version !== pkg.version || npmPackage.version !== pkg.version;

if (!stale) {
  console.log(`server.json is in step with package.json at ${pkg.version}`);
  process.exit(0);
}

if (checkOnly) {
  console.error(
    `server.json is at ${server.version} (npm entry ${npmPackage.version}) ` +
      `while package.json is at ${pkg.version}. Run: node scripts/sync-server-json.mjs`,
  );
  process.exit(1);
}

server.version = pkg.version;
npmPackage.version = pkg.version;
writeFileSync(serverPath, `${JSON.stringify(server, null, 2)}\n`);
console.log(`server.json updated to ${pkg.version}`);
