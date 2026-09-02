import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { canonicalOpenApi, compareDirectories, pathContract, validateOpenApi } from "./openapi-contract.mjs";

const validDocument = {
  paths: { "/health": { get: { responses: { 200: { description: "OK" } } } } },
  info: { version: "1", title: "Contract" },
  openapi: "3.0.3",
};

test("canonicalOpenApi sorts object keys and preserves array order", () => {
  const canonical = canonicalOpenApi({ ...validDocument, tags: [{ name: "z" }, { name: "a" }] });
  assert.equal(canonical.endsWith("\n"), true);
  assert.ok(canonical.indexOf('"info"') < canonical.indexOf('"openapi"'));
  assert.ok(canonical.indexOf('"z"') < canonical.indexOf('"a"'));
  assert.deepEqual(JSON.parse(canonical), {
    info: { title: "Contract", version: "1" },
    openapi: "3.0.3",
    paths: validDocument.paths,
    tags: [{ name: "z" }, { name: "a" }],
  });
});

test("validateOpenApi rejects documents without paths", () => {
  assert.throws(
    () => validateOpenApi({ openapi: "3.0.3", info: { title: "x", version: "1" }, paths: {} }),
    /at least one path/u,
  );
});

test("pathContract is deterministic and sorts OpenAPI paths", () => {
  const forward = {
    ...validDocument,
    paths: {
      "/z-last": validDocument.paths["/health"],
      "/a-first/{id}": validDocument.paths["/health"],
      "/health": {
        ...validDocument.paths["/health"],
        parameters: [],
        post: { responses: { 200: { description: "OK" } } },
      },
    },
  };
  const reverse = {
    ...validDocument,
    paths: Object.fromEntries(Object.entries(forward.paths).reverse()),
  };

  const generated = pathContract(forward);
  assert.equal(generated, pathContract(reverse));
  assert.equal(generated.endsWith("\n"), true);
  assert.ok(generated.indexOf('"/a-first/{id}"') < generated.indexOf('"/health"'));
  assert.ok(generated.indexOf('"/health"') < generated.indexOf('"/z-last"'));
  assert.match(generated, /export type OpenApiPath = \(typeof openApiPaths\)\[number\];/u);
  assert.match(generated, /\{ method: "GET", path: "\/health" \}/u);
  assert.match(generated, /\{ method: "POST", path: "\/health" \}/u);
  assert.doesNotMatch(generated, /method: "PARAMETERS"/u);
  assert.match(generated, /export type OpenApiMethodFor<Path extends OpenApiPath>/u);
});

test("compareDirectories reports added, removed, and changed files", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "vibe-openapi-contract-test-"));
  const expected = join(temporaryDirectory, "expected");
  const actual = join(temporaryDirectory, "actual");
  try {
    await Promise.all([mkdir(expected), mkdir(actual)]);
    await Promise.all([
      writeFile(join(expected, "same.ts"), "same"),
      writeFile(join(actual, "same.ts"), "same"),
      writeFile(join(expected, "changed.ts"), "before"),
      writeFile(join(actual, "changed.ts"), "after"),
      writeFile(join(expected, "only-expected.ts"), "expected"),
      writeFile(join(actual, "only-actual.ts"), "actual"),
    ]);
    assert.deepEqual(await compareDirectories(expected, actual), [
      "changed generated file: changed.ts",
      "unexpected generated file: only-actual.ts",
      "missing generated file: only-expected.ts",
    ]);
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});
