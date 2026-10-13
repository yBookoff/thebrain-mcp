/**
 * Keeps server.json, and the version the server reports, in step with
 * package.json.
 *
 * The MCP Registry entry carries its own version, in two places, and both must
 * match what was published to npm — a stale one either fails validation or,
 * worse, points users at a version that no longer exists. Rather than trusting
 * anyone to remember, `npm version` runs this through its `version` lifecycle
 * hook and stages the result into the release commit.
 *
 * The server carries the version a third time: `SERVER_VERSION` in
 * src/server/index.ts is what it tells every client at `initialize`. It is a
 * constant and not a read of package.json at run time, which would need some
 * version to report when the file is not where it was looked for. Written by
 * hand, it said 0.1.0 from the 0.2.0 package.
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
const sourcePath = join(root, "src", "server", "index.ts");

const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const server = JSON.parse(readFileSync(serverPath, "utf8"));
const source = readFileSync(sourcePath, "utf8");
const checkOnly = process.argv.includes("--check");

/** The one line of the source that says which version the server reports. */
const REPORTED = /^export const SERVER_VERSION = "([^"]*)";$/m;

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

const reported = REPORTED.exec(source)?.[1];
if (reported === undefined) {
  problems.push(
    'src/server/index.ts has no SERVER_VERSION line of the form `export const SERVER_VERSION = "…";`',
  );
}

// Identity mismatches are never safe to fix automatically: they mean someone
// renamed something and only half the rename landed. Nor is a constant that
// is not where it is looked for.
if (problems.length > 0) {
  console.error(problems.map((p) => `  ${p}`).join("\n"));
  process.exit(1);
}

const staleJson = server.version !== pkg.version || npmPackage.version !== pkg.version;
const staleSource = reported !== pkg.version;

if (!staleJson && !staleSource) {
  console.log(`server.json and SERVER_VERSION are in step with package.json at ${pkg.version}`);
  process.exit(0);
}

if (checkOnly) {
  const stale = [
    ...(staleJson
      ? [`server.json is at ${server.version} (npm entry ${npmPackage.version})`]
      : []),
    ...(staleSource ? [`SERVER_VERSION in src/server/index.ts is ${reported}`] : []),
  ];
  console.error(
    `${stale.join(" and ")} while package.json is at ${pkg.version}. ` +
      "Run: node scripts/sync-server-json.mjs",
  );
  process.exit(1);
}

if (staleJson) {
  server.version = pkg.version;
  npmPackage.version = pkg.version;
  writeFileSync(serverPath, `${JSON.stringify(server, null, 2)}\n`);
  console.log(`server.json updated to ${pkg.version}`);
}
if (staleSource) {
  writeFileSync(
    sourcePath,
    source.replace(REPORTED, `export const SERVER_VERSION = "${pkg.version}";`),
  );
  console.log(`SERVER_VERSION in src/server/index.ts updated to ${pkg.version}`);
}
