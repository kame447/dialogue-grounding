import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Expand the file patterns used by npm test, without running npm or a shell.
// Fail if the test command changes shape so CI cannot silently run fewer tests.
export function discoverTestFiles(root: string): string[] {
  const { scripts } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts?: { test?: unknown } };
  if (typeof scripts?.test !== "string") throw new Error("Missing npm test script");
  const [node, flag, ...patterns] = scripts.test.trim().split(/\s+/u);
  if (node !== "node" || flag !== "--test" || !patterns.length) {
    throw new Error("Expected npm test to be node --test with file patterns");
  }
  const files = patterns.flatMap(pattern => {
    const match = /^((?:[\w.-]+\/)+)\*(\.test\.[cm]?[jt]s)$/u.exec(pattern);
    if (!match || match[1].split("/").some(part => part === "." || part === "..")) {
      throw new Error(`Unsupported npm test pattern: ${pattern}`);
    }
    const [, directory, suffix] = match;
    const paths = readdirSync(join(root, directory))
      .filter(name => !name.startsWith(".") && name.endsWith(suffix))
      .map(name => directory + name);
    if (!paths.length) throw new Error(`No files match npm test pattern: ${pattern}`);
    for (const path of paths) {
      if (!statSync(join(root, path)).isFile()) throw new Error(`Not a test file: ${path}`);
    }
    return paths;
  });
  if (new Set(files).size !== files.length) throw new Error("Overlapping npm test patterns");
  return files.sort();
}

export function validateShards(files: readonly string[], plan: unknown, count: number): asserts plan is string[][] {
  if (!Array.isArray(plan) || plan.length !== count) throw new Error(`Expected ${count} test shards`);
  const remaining = new Set(files);
  const expected = new Set(files);
  for (const [index, shard] of plan.entries()) {
    if (!Array.isArray(shard) || !shard.length) throw new Error(`Test shard ${index + 1} is empty or invalid`);
    for (const file of shard) {
      if (typeof file !== "string" || !expected.has(file)) throw new Error(`Unexpected test file in shard ${index + 1}: ${file}`);
      if (!remaining.delete(file)) throw new Error(`Repeated test file: ${file}`);
    }
  }
  if (remaining.size) throw new Error(`Missing test files: ${[...remaining].join(", ")}`);
}

export function buildShards(files: readonly string[], count: number): string[][] {
  if (!Number.isSafeInteger(count) || count < 1 || count > files.length) throw new Error("Invalid test shard count");
  const shards: string[][] = Array.from({ length: count }, () => []);
  for (const [index, file] of files.entries()) shards[index % count].push(file);
  validateShards(files, shards, count);
  return shards;
}

function main(): void {
  const [command, argument] = process.argv.slice(2);
  const count = Number(process.env.SHARD_COUNT);
  const files = discoverTestFiles(process.cwd());
  if (command === "plan") {
    const shards = buildShards(files, count);
    console.log("matrix=" + JSON.stringify(shards.map((_, index) => index + 1)));
    console.log("shards=" + JSON.stringify(shards));
    return;
  }
  if (command !== "run") throw new Error("Expected plan or run");
  const index = Number(argument);
  if (!Number.isSafeInteger(index) || index < 1 || index > count) throw new Error("Invalid test shard index");
  const shards: unknown = JSON.parse(process.env.TEST_SHARDS ?? "null");
  validateShards(files, shards, count);
  const shard = shards[index - 1];
  console.log(`Test shard ${index}/${count}: ${shard.length} of ${files.length} files`);
  const result = spawnSync(process.execPath, ["--test", ...shard], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status === null) throw new Error(`Test process terminated with signal ${result.signal}`);
  process.exitCode = result.status;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
