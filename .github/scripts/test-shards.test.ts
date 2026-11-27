import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildShards, discoverTestFiles, validateShards } from "./test-shards.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const script = fileURLToPath(new URL("./test-shards.ts", import.meta.url));

for (const count of [2, 4]) {
  test(`the ${count}-job matrix covers the npm test files exactly once`, () => {
    const files = discoverTestFiles(root);
    const run = spawnSync(process.execPath, [script, "plan"], {
      cwd: root, encoding: "utf8", env: { ...process.env, SHARD_COUNT: String(count) },
    });
    assert.equal(run.status, 0, run.stderr);
    const [matrixLine, planLine] = run.stdout.trim().split("\n");
    const matrix: unknown = JSON.parse(matrixLine.slice("matrix=".length));
    const plan: unknown = JSON.parse(planLine.slice("shards=".length));
    validateShards(files, plan, count);
    assert.deepEqual(matrix, Array.from({ length: count }, (_, index) => index + 1));
    assert.deepEqual(plan.flat().sort(), files);
    const sizes = plan.map(shard => shard.length);
    assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1);
  });
}

test("missing, repeated and unexpected tests make a shard plan invalid", () => {
  const files = ["a.test.ts", "b.test.mjs", "c.test.ts", "d.test.mjs"];
  const good = buildShards(files, 2);
  assert.doesNotThrow(() => validateShards(files, good, 2));
  assert.throws(() => validateShards(files, [good[0], [files[1]]], 2), /Missing test files: d.test.mjs/u);
  assert.throws(() => validateShards(files, [good[0], [...good[1], files[0]]], 2), /Repeated test file/u);
  assert.throws(() => validateShards(files, [good[0], [...good[1], "other.test.ts"]], 2), /Unexpected test file/u);
  assert.throws(() => validateShards(files, [good[0]], 2), /Expected 2 test shards/u);
  assert.throws(() => validateShards(files, [good[0], []], 2), /shard 2 is empty/u);
});

test("the shard runner rejects a damaged manifest before any test is started", () => {
  const files = discoverTestFiles(root);
  const plan = buildShards(files, 2);
  plan[1].pop();
  const run = spawnSync(process.execPath, [script, "run", "1"], {
    cwd: root, encoding: "utf8", env: { ...process.env, SHARD_COUNT: "2", TEST_SHARDS: JSON.stringify(plan) },
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Missing test files/u);
  assert.equal(run.stdout, "");
});

test("the shard runner propagates a failing test's exit status", t => {
  const cwd = mkdtempSync(join(tmpdir(), "test-shards-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, "tests"));
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "node --test tests/*.test.mjs" } }));
  writeFileSync(join(cwd, "tests/a.test.mjs"), 'import test from "node:test"; test("deliberate failure", () => { throw Error("synthetic"); });');
  writeFileSync(join(cwd, "tests/b.test.mjs"), 'import test from "node:test"; test("other shard", () => {});');
  // Match the runner's top-level invocation from GitHub Actions.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, [script, "run", "1"], {
    cwd, encoding: "utf8",
    env: { ...env, SHARD_COUNT: "2", TEST_SHARDS: JSON.stringify([["tests/a.test.mjs"], ["tests/b.test.mjs"]]) },
  });
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stdout, /deliberate failure/u);
  assert.doesNotMatch(run.stdout, /other shard/u);
});
