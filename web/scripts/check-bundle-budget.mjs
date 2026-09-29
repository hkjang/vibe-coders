import { readFileSync, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { JSDOM, VirtualConsole } from "jsdom";
import ts from "typescript";

export const INITIAL_WIRE_LIMIT = 350_000;
export const ROUTE_RAW_LIMIT = 250_000;

// Keep this allowlist aligned with internal/appui/handler.go: compressibleAsset.
const compressible = new Set([".css", ".html", ".js", ".json", ".map", ".svg", ".txt", ".webmanifest"]);
const modules = new Set([".js", ".mjs", ".cjs"]);
const manifestFields = new Set([
  "file",
  "src",
  "name",
  "names",
  "isEntry",
  "isDynamicEntry",
  "imports",
  "dynamicImports",
  "css",
  "assets",
]);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const controlCharacter = (value) =>
  [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

function fail(message) {
  throw new Error(message);
}

function manifestPath(value, label) {
  if (
    typeof value !== "string" ||
    !value ||
    value.trim() !== value ||
    controlCharacter(value) ||
    /[\\?#%]/u.test(value) ||
    value.startsWith("/") ||
    /^[a-z][a-z\d+.-]*:/iu.test(value) ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    fail(`${label}: invalid relative path`);
  }
  return value;
}

function validateManifest(manifest) {
  if (!object(manifest) || Object.keys(manifest).length === 0) fail("manifest must be a nonempty object");
  for (const [key, record] of Object.entries(manifest)) {
    manifestPath(key, "manifest key");
    if (!object(record)) fail(`${key}: manifest record must be an object`);
    for (const field of Object.keys(record)) {
      if (!manifestFields.has(field)) fail(`${key}: unsupported manifest field ${field}`);
    }
    manifestPath(record.file, `${key}.file`);
    for (const field of ["src", "name"]) {
      if (field in record && (typeof record[field] !== "string" || !record[field]))
        fail(`${key}.${field}: expected string`);
    }
    if ("src" in record) manifestPath(record.src, `${key}.src`);
    for (const field of ["isEntry", "isDynamicEntry"]) {
      if (field in record && typeof record[field] !== "boolean") fail(`${key}.${field}: expected boolean`);
    }
    for (const field of ["imports", "dynamicImports", "css", "assets", "names"]) {
      if (!(field in record)) continue;
      if (
        !Array.isArray(record[field]) ||
        record[field].some((value) => typeof value !== "string" || !value)
      ) {
        fail(`${key}.${field}: expected string array`);
      }
      if (field !== "names") record[field].forEach((value) => manifestPath(value, `${key}.${field}`));
    }
    for (const dependency of [...(record.imports ?? []), ...(record.dynamicImports ?? [])]) {
      if (!Object.hasOwn(manifest, dependency)) fail(`${key}: missing manifest record ${dependency}`);
    }
  }
  if (!Object.hasOwn(manifest, "index.html") || manifest["index.html"].isEntry !== true) {
    fail("manifest must contain the index.html entry with isEntry=true");
  }
  if (!Object.values(manifest).some((record) => record.isDynamicEntry === true))
    fail("manifest has no dynamic entry");
}

// URL paths are decoded before checking containment. Only /app/ is served by
// this dist; data URLs and local fragments are already represented by the parent.
function resourcePath(value, parent) {
  const input = value.trim();
  if (!input || controlCharacter(input) || input.includes("\\")) fail(`${parent}: invalid resource URL`);
  if (/^data:/iu.test(input) || input.startsWith("#")) return null;
  if (input.startsWith("//") || /^[a-z][a-z\d+.-]*:/iu.test(input)) fail(`${parent}: external resource URL`);
  let pathname;
  try {
    pathname = decodeURIComponent(input.split(/[?#]/u, 1)[0]);
  } catch {
    fail(`${parent}: invalid URL encoding`);
  }
  if (!pathname || controlCharacter(pathname) || /[\\%?#]/u.test(pathname))
    fail(`${parent}: invalid resource path`);
  if (pathname.startsWith("/")) {
    if (!pathname.startsWith("/app/")) fail(`${parent}: resource is outside /app/: ${pathname}`);
    pathname = pathname.slice(5);
  } else {
    pathname = posix.join(posix.dirname(parent), pathname);
  }
  const normalized = posix.normalize(pathname);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/")
  ) {
    fail(`${parent}: resource escapes dist`);
  }
  return normalized;
}

function cssEscape(text, start) {
  let index = start + 1;
  if (index >= text.length) fail("unterminated CSS escape");
  if (/[\r\n\f]/u.test(text[index])) {
    if (text[index] === "\r" && text[index + 1] === "\n") index++;
    return ["", index + 1];
  }
  const hex = text.slice(index).match(/^[\da-f]{1,6}/iu)?.[0];
  if (hex) {
    index += hex.length;
    if (/\s/u.test(text[index] ?? "")) {
      if (text[index] === "\r" && text[index + 1] === "\n") index++;
      index++;
    }
    const code = Number.parseInt(hex, 16);
    return [code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "\ufffd", index];
  }
  return [text[index], index + 1];
}

function cssString(text, start) {
  const quote = text[start];
  let value = "";
  let index = start + 1;
  while (index < text.length) {
    if (text[index] === quote) return [value, index + 1];
    if (text[index] === "\\") {
      const [decoded, next] = cssEscape(text, index);
      value += decoded;
      index = next;
    } else {
      if (/[\r\n\f]/u.test(text[index])) fail("unterminated CSS string");
      value += text[index++];
    }
  }
  fail("unterminated CSS string");
}

function cssSpace(text, start) {
  let index = start;
  while (index < text.length) {
    if (/\s/u.test(text[index])) index++;
    else if (text.startsWith("/*", index)) {
      const end = text.indexOf("*/", index + 2);
      if (end < 0) fail("unterminated CSS comment");
      index = end + 2;
    } else break;
  }
  return index;
}

// Tokenize references without executing CSS or fetching @imports. Escapes,
// comments, quoted parentheses and image-set string URLs cannot hide resources.
function cssReferences(text) {
  const references = [];
  const functions = [];
  let index = 0;
  while (index < text.length) {
    index = cssSpace(text, index);
    const character = text[index];
    if (character === '"' || character === "'") {
      const [value, next] = cssString(text, index);
      if (functions.at(-1)?.candidate) {
        references.push(value);
        functions.at(-1).candidate = false;
      }
      index = next;
      continue;
    }
    if (character === "@" || character === "\\" || /[-\w]/u.test(character ?? "")) {
      const atRule = character === "@";
      if (atRule) index++;
      let identifier = "";
      while (index < text.length && (text[index] === "\\" || /[-\w]/u.test(text[index]))) {
        if (text[index] === "\\") {
          const [value, next] = cssEscape(text, index);
          identifier += value;
          index = next;
        } else identifier += text[index++];
      }
      identifier = identifier.toLowerCase();
      index = cssSpace(text, index);
      if (atRule && identifier === "import" && (text[index] === '"' || text[index] === "'")) {
        const [value, next] = cssString(text, index);
        references.push(value);
        index = next;
      } else if (text[index] === "(") {
        if (functions.at(-1)?.candidate) functions.at(-1).candidate = false;
        index = cssSpace(text, index + 1);
        if (identifier !== "url") {
          functions.push(/^(?:-webkit-)?image-set$/u.test(identifier) ? { candidate: true } : null);
          continue;
        }
        let value = "";
        if (text[index] === '"' || text[index] === "'") {
          [value, index] = cssString(text, index);
          index = cssSpace(text, index);
        } else {
          while (index < text.length && text[index] !== ")") {
            if (text[index] === "\\") {
              const [decoded, next] = cssEscape(text, index);
              value += decoded;
              index = next;
            } else value += text[index++];
          }
          value = value.trim();
        }
        if (text[index] !== ")") fail("unterminated CSS url()");
        references.push(value);
        index++;
      }
      continue;
    }
    if (character === "(") functions.push(null);
    if (character === ")") functions.pop();
    if (character === "," && functions.at(-1)) functions.at(-1).candidate = true;
    index++;
  }
  return references;
}

function srcsetReferences(text) {
  const references = [];
  let index = 0;
  while (index < text.length) {
    while (/[\s,]/u.test(text[index] ?? "")) index++;
    const start = index;
    const data = /^data:/iu.test(text.slice(index));
    while (index < text.length && !/\s/u.test(text[index]) && (data || text[index] !== ",")) index++;
    if (index > start) {
      const candidate = text.slice(start, index);
      // The HTML srcset algorithm treats trailing commas as candidate separators,
      // even when the URL itself is a data URI. Do not consume the next URL as
      // this descriptor-less candidate's descriptor.
      if (candidate.endsWith(",")) {
        references.push(candidate.replace(/,+$/u, ""));
        continue;
      }
      references.push(candidate);
    }
    while (index < text.length && text[index] !== ",") index++;
    if (text[index] === ",") index++;
  }
  return references;
}

function htmlReferences(html, excluded) {
  // No runScripts or resources option: jsdom neither executes nor downloads.
  const dom = new JSDOM(html, { virtualConsole: new VirtualConsole() });
  try {
    const document = dom.window.document;
    if (document.querySelector("base[href]")) fail("index.html: base href is unsupported");
    const references = [];
    for (const [selector, attribute] of [
      [
        "script[src],img[src],source[src],audio[src],video[src],track[src],input[type=image][src],iframe[src],embed[src]",
        "src",
      ],
      ["video[poster]", "poster"],
      ["object[data]", "data"],
      ["svg image[href],svg use[href]", "href"],
      ["svg image[xlink\\:href],svg use[xlink\\:href]", "xlink:href"],
    ]) {
      for (const element of document.querySelectorAll(selector))
        references.push(
          element.tagName === "SCRIPT"
            ? { url: element.getAttribute(attribute), requiresRecord: true }
            : element.getAttribute(attribute),
        );
    }
    for (const link of document.querySelectorAll("link[href]")) {
      const rel = (link.getAttribute("rel") ?? "").toLowerCase().split(/\s+/u);
      if (
        !rel.some((value) =>
          ["stylesheet", "modulepreload", "preload", "prefetch", "icon", "manifest"].includes(value),
        )
      )
        continue;
      const href = link.getAttribute("href");
      if (href === "/favicon.ico" && rel.includes("icon")) {
        excluded.add("/favicon.ico");
      } else
        references.push(
          rel.includes("modulepreload") || link.getAttribute("as")?.toLowerCase() === "script"
            ? { url: href, requiresRecord: true }
            : href,
        );
    }
    for (const element of document.querySelectorAll("[srcset],[imagesrcset]")) {
      for (const attribute of ["srcset", "imagesrcset"]) {
        if (element.hasAttribute(attribute))
          references.push(...srcsetReferences(element.getAttribute(attribute)));
      }
    }
    for (const element of document.querySelectorAll("style,[style]")) {
      if (element.tagName === "STYLE") references.push(...cssReferences(element.textContent));
      if (element.hasAttribute("style")) references.push(...cssReferences(element.getAttribute("style")));
    }
    return references;
  } finally {
    dom.window.close();
  }
}

function moduleReferences(name, data) {
  const source = ts.createSourceFile(
    name,
    data.toString("utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  if (source.parseDiagnostics.length) fail(`${name}: invalid JavaScript syntax`);
  const references = [];
  const unresolved = [];
  const isLiteral = (node) => node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node));
  function literal(node, kind) {
    if (!isLiteral(node)) {
      fail(`${name}: computed ${kind} cannot be budgeted`);
    }
    return node.text;
  }
  function unwrap(node) {
    while (node && ts.isParenthesizedExpression(node)) node = node.expression;
    return node;
  }
  function importMetaURL(node) {
    node = unwrap(node);
    if (!node || !ts.isPropertyAccessExpression(node) || node.name.text !== "url") return false;
    const expression = unwrap(node.expression);
    return (
      ts.isMetaProperty(expression) &&
      expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
      expression.name.text === "meta"
    );
  }
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      references.push({ kind: "imports", url: literal(node.moduleSpecifier, "module import") });
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      if (isLiteral(node.arguments[0]))
        references.push({ kind: "dynamicImports", url: node.arguments[0].text });
      else unresolved.push("dynamic-import");
    } else if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "URL" &&
      importMetaURL(node.arguments?.[1])
    ) {
      if (isLiteral(node.arguments[0])) references.push({ kind: "asset", url: node.arguments[0].text });
      else unresolved.push("import-meta-url");
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return { references, unresolved };
}

/** Filesystem-independent accounting; readFile supplies validated local bytes. */
export function analyzeBundle(manifest, readFile) {
  validateManifest(manifest);
  const bytes = new Map();
  const recordsByFile = new Map();
  const excluded = new Set();
  function read(name) {
    if (!bytes.has(name)) {
      const data = readFile(name);
      if (!Buffer.isBuffer(data)) fail(`${name}: file reader must return a Buffer`);
      bytes.set(name, data);
    }
    return bytes.get(name);
  }
  for (const [key, record] of Object.entries(manifest)) {
    const keys = recordsByFile.get(record.file) ?? [];
    keys.push(key);
    recordsByFile.set(record.file, keys);
    for (const file of [record.file, ...(record.css ?? []), ...(record.assets ?? [])]) read(file);
  }
  const moduleAssets = new Map();
  const unresolvedRuntimeReferences = [];
  function verifyModule(name) {
    if (!modules.has(extname(name).toLowerCase()) || moduleAssets.has(name)) return;
    const assets = [];
    moduleAssets.set(name, assets);
    const owners = recordsByFile.get(name) ?? [];
    const module = moduleReferences(name, read(name));
    for (const kind of new Set(module.unresolved)) {
      unresolvedRuntimeReferences.push({
        file: name,
        kind,
        count: module.unresolved.filter((value) => value === kind).length,
      });
    }
    for (const { kind, url } of module.references) {
      const dependency = resourcePath(url, name);
      if (kind === "asset") {
        if (dependency !== null) assets.push(dependency);
        continue;
      }
      if (dependency === null) fail(`${name}: inline/fragment module imports are unsupported`);
      if (!recordsByFile.has(dependency)) fail(`${name}: missing manifest record for module ${dependency}`);
      const declared = owners.some((key) =>
        (manifest[key][kind] ?? []).some((key) => manifest[key].file === dependency),
      );
      if (!declared) fail(`${name}: ${kind} missing manifest edge to ${dependency}`);
    }
  }
  // Vite omits external modules from its manifest. Inspect emitted syntax too,
  // without executing it; ordinary fetch/API URLs are intentionally not examined.
  for (const name of bytes.keys()) verifyModule(name);
  function closure(rootKey, cachedKeys = new Set(), cachedFiles = new Set(), dynamic = false) {
    const keys = new Set();
    const files = new Set();
    function addFile(name) {
      if (cachedFiles.has(name) || files.has(name)) return;
      files.add(name);
      const data = read(name);
      verifyModule(name);
      for (const key of recordsByFile.get(name) ?? []) visit(key);
      const extension = extname(name).toLowerCase();
      const references =
        extension === ".css"
          ? cssReferences(data.toString("utf8"))
          : extension === ".html"
            ? htmlReferences(data.toString("utf8"), excluded)
            : (moduleAssets.get(name) ?? []).map((url) => ({ resolved: url }));
      for (const reference of references) {
        const dependency =
          reference.resolved ?? resourcePath(typeof reference === "string" ? reference : reference.url, name);
        if (dependency === null) continue;
        if (
          (reference.requiresRecord || modules.has(extname(dependency).toLowerCase())) &&
          !recordsByFile.has(dependency)
        ) {
          fail(`${name}: missing manifest record for ${dependency}`);
        }
        addFile(dependency);
      }
    }
    function visit(key) {
      // Stop BEFORE following a cached entry's dynamic imports: the shell may
      // enumerate every route, which is not part of this cold route envelope.
      if (cachedKeys.has(key) || keys.has(key)) return;
      keys.add(key);
      const record = manifest[key];
      for (const file of [record.file, ...(record.css ?? []), ...(record.assets ?? [])]) addFile(file);
      for (const dependency of [...(record.imports ?? []), ...(dynamic ? (record.dynamicImports ?? []) : [])])
        visit(dependency);
    }
    visit(rootKey);
    if (!dynamic) addFile("index.html");
    return { keys, files };
  }
  const initialClosure = closure("index.html");
  const routeClosures = Object.entries(manifest)
    .filter(([, value]) => value.isDynamicEntry === true)
    .sort(([left], [right]) => compare(left, right))
    .map(([entry]) => ({ entry, ...closure(entry, initialClosure.keys, initialClosure.files, true) }));
  const measurements = new Map(
    [...bytes].map(([path, data]) => {
      const rawBytes = data.length;
      const gzipBytes = gzipSync(data, { level: 9 }).length;
      const encoded = compressible.has(extname(path).toLowerCase()) && gzipBytes < rawBytes;
      return [
        path,
        {
          path,
          rawBytes,
          gzipBytes,
          wireBytes: encoded ? gzipBytes : rawBytes,
          encoding: encoded ? "gzip" : "identity",
        },
      ];
    }),
  );
  function totals(files) {
    const paths = [...files].sort();
    return paths.reduce(
      (result, path) => {
        for (const field of ["rawBytes", "gzipBytes", "wireBytes"])
          result[field] += measurements.get(path)[field];
        return result;
      },
      { files: paths, rawBytes: 0, gzipBytes: 0, wireBytes: 0 },
    );
  }
  const initial = { entry: "index.html", ...totals(initialClosure.files) };
  initial.passed = initial.wireBytes <= INITIAL_WIRE_LIMIT;
  const routes = routeClosures.map(({ entry, files }) => {
    const result = { entry, ...totals(files) };
    return { ...result, passed: result.rawBytes <= ROUTE_RAW_LIMIT };
  });
  return {
    schemaVersion: 1,
    passed: initial.passed && routes.every((route) => route.passed),
    limits: { initialWireBytes: INITIAL_WIRE_LIMIT, routeRawBytes: ROUTE_RAW_LIMIT },
    accounting:
      "Per-file Node gzip level 9; Go-compressible files use min(raw,gzip), other assets use raw. Routes conservatively include uncached manifest nested dynamic imports. Computed runtime references are reported, not resolved or measured; this is not an HTTP timing measurement.",
    initial,
    routes,
    files: [...measurements.values()].sort((left, right) => compare(left.path, right.path)),
    excluded: [...excluded]
      .sort()
      .map((url) => ({ url, reason: "Go-owned favicon, not part of the /app dist" })),
    unresolvedRuntimeReferences: unresolvedRuntimeReferences.sort(
      (left, right) => compare(left.file, right.file) || compare(left.kind, right.kind),
    ),
  };
}

export function checkBundleDirectory(directory) {
  const root = realpathSync(resolve(directory));
  if (!statSync(root).isDirectory()) fail("dist must be a directory");
  function readFile(name) {
    const target = realpathSync(resolve(root, name));
    const inside = relative(root, target);
    if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside))
      fail(`${name}: file escapes dist (symlink)`);
    if (!statSync(target).isFile()) fail(`${name}: expected regular file`);
    return readFileSync(target);
  }
  const manifest = JSON.parse(readFile(".vite/manifest.json").toString("utf8"));
  return analyzeBundle(manifest, readFile);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || args[0]?.startsWith("-"))
      fail("usage: node scripts/check-bundle-budget.mjs [dist-directory]");
    const report = checkBundleDirectory(args[0] ?? "dist");
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    const failedRoutes = report.routes.filter((route) => !route.passed);
    process.stderr.write(
      `번들 예산 ${report.passed ? "통과" : "초과"}: 초기 ${report.initial.wireBytes}/${INITIAL_WIRE_LIMIT} bytes, 화면 ${report.routes.length}개 (초과 ${failedRoutes.length}개)\n`,
    );
    if (!report.passed) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`번들 예산 검사 실패: ${error.message}\n`);
    process.exitCode = 1;
  }
}
