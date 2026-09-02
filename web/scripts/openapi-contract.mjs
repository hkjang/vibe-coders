import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createClient } from "@hey-api/openapi-ts";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const webDirectory = resolve(scriptDirectory, "..");
const snapshotPath = join(webDirectory, "openapi", "openapi.json");
const generatedPath = join(webDirectory, "src", "shared", "api", "generated");
const defaultOpenApiUrl = "http://127.0.0.1:8080/openapi.json";
const generatedPathsFile = "paths.gen.ts";
const httpMethods = new Set(["delete", "get", "head", "options", "patch", "post", "put", "trace"]);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;

  const result = {};
  for (const key of Object.keys(value).sort()) result[key] = sortJson(value[key]);
  return result;
}

export function validateOpenApi(value) {
  if (!isRecord(value)) throw new Error("OpenAPI document must be a JSON object");
  if (typeof value.openapi !== "string" || !/^3\.(?:0|1)\.\d+$/.test(value.openapi)) {
    throw new Error("OpenAPI document must declare an OpenAPI 3.0 or 3.1 version");
  }
  if (
    !isRecord(value.info) ||
    typeof value.info.title !== "string" ||
    typeof value.info.version !== "string"
  ) {
    throw new Error("OpenAPI document must include info.title and info.version");
  }
  if (!isRecord(value.paths) || Object.keys(value.paths).length === 0) {
    throw new Error("OpenAPI document must include at least one path");
  }
  return value;
}

export function canonicalOpenApi(value) {
  return `${JSON.stringify(sortJson(validateOpenApi(value)), null, 2)}\n`;
}

export function pathContract(value) {
  const specification = validateOpenApi(value);
  const paths = Object.keys(specification.paths).sort();
  const operations = paths.flatMap((path) => {
    const pathItem = specification.paths[path];
    if (!isRecord(pathItem)) return [];
    return Object.keys(pathItem)
      .filter((method) => httpMethods.has(method.toLowerCase()))
      .sort()
      .map((method) => ({ method: method.toUpperCase(), path }));
  });
  const lines = [
    "// This file is auto-generated from openapi/openapi.json. Do not edit manually.",
    "",
    "export const openApiPaths = [",
    ...paths.map((path) => `  ${JSON.stringify(path)},`),
    "] as const;",
    "",
    "export type OpenApiPath = (typeof openApiPaths)[number];",
    "",
    "export const openApiOperations = [",
    ...operations.map(
      ({ method, path }) => `  { method: ${JSON.stringify(method)}, path: ${JSON.stringify(path)} },`,
    ),
    "] as const;",
    "",
    "export type OpenApiOperation = (typeof openApiOperations)[number];",
    'export type OpenApiMethod = OpenApiOperation["method"];',
    "export type OpenApiMethodFor<Path extends OpenApiPath> = Extract<",
    "  OpenApiOperation,",
    "  { readonly path: Path }",
    '>["method"];',
    "",
  ];
  return lines.join("\n");
}

async function readJsonSource(source) {
  let text;
  if (/^https?:\/\//u.test(source)) {
    const response = await fetch(source, {
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`OpenAPI request failed: HTTP ${response.status}`);
    text = await response.text();
  } else {
    text = await readFile(resolve(process.cwd(), source), "utf8");
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`OpenAPI source is not valid JSON: ${source}`, { cause: error });
  }
}

async function generateTypes(specification, outputPath) {
  await createClient({
    input: sortJson(validateOpenApi(specification)),
    output: { clean: true, path: outputPath },
    plugins: ["@hey-api/typescript"],
    logs: { file: false, level: "silent" },
  });
  await writeFile(join(outputPath, generatedPathsFile), pathContract(specification), "utf8");
}

async function walkFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) files.push(...(await walkFiles(root, absolute)));
    else if (entry.isFile()) files.push(relative(root, absolute).replaceAll("\\", "/"));
  }
  return files;
}

export async function compareDirectories(expectedPath, actualPath) {
  const [expectedFiles, actualFiles] = await Promise.all([walkFiles(expectedPath), walkFiles(actualPath)]);
  const mismatches = [];
  const allFiles = [...new Set([...expectedFiles, ...actualFiles])].sort();

  for (const file of allFiles) {
    if (!expectedFiles.includes(file)) {
      mismatches.push(`unexpected generated file: ${file}`);
      continue;
    }
    if (!actualFiles.includes(file)) {
      mismatches.push(`missing generated file: ${file}`);
      continue;
    }
    const [expected, actual] = await Promise.all([
      readFile(join(expectedPath, file)),
      readFile(join(actualPath, file)),
    ]);
    if (!expected.equals(actual)) mismatches.push(`changed generated file: ${file}`);
  }
  return mismatches;
}

async function readCommittedSnapshot() {
  const text = await readFile(snapshotPath, "utf8");
  let specification;
  try {
    specification = JSON.parse(text);
  } catch (error) {
    throw new Error("Committed OpenAPI snapshot is not valid JSON", { cause: error });
  }
  const canonical = canonicalOpenApi(specification);
  if (text !== canonical) {
    throw new Error("Committed OpenAPI snapshot is not canonical; run pnpm openapi:snapshot");
  }
  return { canonical, specification };
}

async function snapshot(source) {
  const specification = await readJsonSource(source);
  const canonical = canonicalOpenApi(specification);
  await mkdir(dirname(snapshotPath), { recursive: true });
  await writeFile(snapshotPath, canonical, "utf8");
  await generateTypes(specification, generatedPath);
  console.log(
    `Updated ${relative(webDirectory, snapshotPath)} and ${relative(webDirectory, generatedPath)} from ${source}`,
  );
}

async function generate() {
  const { specification } = await readCommittedSnapshot();
  await generateTypes(specification, generatedPath);
  console.log(`Generated ${relative(webDirectory, generatedPath)} from the committed OpenAPI snapshot`);
}

async function check(liveSource) {
  const { canonical, specification } = await readCommittedSnapshot();
  if (liveSource) {
    const liveCanonical = canonicalOpenApi(await readJsonSource(liveSource));
    if (liveCanonical !== canonical) {
      throw new Error(
        `Live OpenAPI contract differs from openapi/openapi.json (${liveSource}); run pnpm openapi:snapshot -- ${liveSource}`,
      );
    }
  }

  const temporaryDirectory = await mkdtemp(join(tmpdir(), "vibe-openapi-contract-"));
  const temporaryGeneratedPath = join(temporaryDirectory, "generated");
  try {
    await generateTypes(specification, temporaryGeneratedPath);
    await stat(generatedPath);
    const mismatches = await compareDirectories(temporaryGeneratedPath, generatedPath);
    if (mismatches.length > 0) {
      throw new Error(
        `Generated OpenAPI types are stale:\n${mismatches.map((item) => `- ${item}`).join("\n")}\nRun pnpm openapi:generate`,
      );
    }
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
  console.log(`OpenAPI contract is current${liveSource ? ` and matches ${liveSource}` : ""}`);
}

async function main() {
  const command = process.argv[2];
  const source =
    process.argv.slice(3).find((argument) => argument !== "--") ??
    process.env.OPENAPI_INPUT ??
    process.env.OPENAPI_URL;
  if (command === "snapshot") {
    await snapshot(source ?? defaultOpenApiUrl);
    return;
  }
  if (command === "generate") {
    await generate();
    return;
  }
  if (command === "check") {
    await check(source);
    return;
  }
  throw new Error("Usage: openapi-contract.mjs <snapshot|generate|check> [OpenAPI file or URL]");
}

const entryPoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === entryPoint) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
