import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { analyzeBundle, INITIAL_WIRE_LIMIT, ROUTE_RAW_LIMIT } from "./check-bundle-budget.mjs";

const script = fileURLToPath(new URL("./check-bundle-budget.mjs", import.meta.url));
const buildScript = fileURLToPath(new URL("./build-bundle-budget.mjs", import.meta.url));

function fixture() {
  return {
    manifest: {
      "index.html": {
        file: "assets/index.js",
        isEntry: true,
        imports: ["_shared.js"],
        dynamicImports: ["src/route.js"],
        css: ["assets/shell.css"],
      },
      "_shared.js": { file: "assets/shared.js" },
      "src/route.js": { file: "assets/route.js", isDynamicEntry: true, imports: ["_shared.js"] },
    },
    files: new Map(
      Object.entries({
        "index.html":
          '<!doctype html><link rel="icon" href="/favicon.ico"><script type="module" src="/app/assets/index.js"></script><link rel="modulepreload" href="/app/assets/shared.js"><link rel="stylesheet" href="/app/assets/shell.css">',
        "assets/index.js": "export {};",
        "assets/shared.js": "shared();",
        "assets/route.js": "route();",
        "assets/shell.css": "body{color:black}",
      }).map(([name, data]) => [name, Buffer.from(data)]),
    ),
  };
}

function analyze({ manifest, files }) {
  return analyzeBundle(manifest, (name) => {
    assert.ok(files.has(name), `missing file ${name}`);
    return files.get(name);
  });
}

function route(report, entry = "src/route.js") {
  return report.routes.find((candidate) => candidate.entry === entry);
}

test("initial entry includes actual HTML, static imports and CSS once; routes subtract cached files", () => {
  const input = fixture();
  const report = analyze(input);
  assert.equal(report.passed, true);
  assert.deepEqual(report.limits, { initialWireBytes: 350_000, routeRawBytes: 250_000 });
  assert.deepEqual(report.initial.files, [
    "assets/index.js",
    "assets/shared.js",
    "assets/shell.css",
    "index.html",
  ]);
  assert.deepEqual(route(report).files, ["assets/route.js"]);
  assert.equal(route(report).rawBytes, 8);
  assert.equal(route(report).wireBytes, 8, "small text is served raw when gzip is larger");
  assert.equal(route(report).gzipBytes, gzipSync(input.files.get("assets/route.js"), { level: 9 }).length);
  assert.deepEqual(report.excluded, [
    { url: "/favicon.ico", reason: "Go-owned favicon, not part of the /app dist" },
  ]);
  assert.deepEqual(analyze(input), report, "accounting is deterministic and does not mutate the input");
});

test("initial wire boundary is inclusive and incompressible-service assets retain raw cost", () => {
  const input = fixture();
  const base = analyze(input).initial.wireBytes;
  input.manifest["index.html"].assets = ["assets/font.woff2"];
  input.files.set("assets/font.woff2", Buffer.alloc(INITIAL_WIRE_LIMIT - base));
  let report = analyze(input);
  assert.equal(report.initial.wireBytes, INITIAL_WIRE_LIMIT);
  assert.equal(report.passed, true);
  const font = report.files.find((file) => file.path === "assets/font.woff2");
  assert.equal(font.encoding, "identity");
  assert.equal(font.wireBytes, font.rawBytes);
  assert.ok(font.gzipBytes < font.rawBytes / 100);
  input.files.set("assets/font.woff2", Buffer.alloc(INITIAL_WIRE_LIMIT - base + 1));
  report = analyze(input);
  assert.equal(report.initial.wireBytes, INITIAL_WIRE_LIMIT + 1);
  assert.equal(report.passed, false);
});

test("per-file gzip level 9 is summed instead of gzipping concatenated files", () => {
  const input = fixture();
  for (const file of ["assets/index.js", "assets/shared.js", "assets/shell.css"]) {
    input.files.set(file, Buffer.from("abcdefghij".repeat(50_000)));
  }
  const report = analyze(input);
  const expected = report.initial.files.reduce(
    (total, path) => total + gzipSync(input.files.get(path), { level: 9 }).length,
    0,
  );
  assert.equal(report.initial.gzipBytes, expected);
  assert.ok(report.initial.rawBytes > INITIAL_WIRE_LIMIT);
  assert.ok(report.initial.wireBytes < INITIAL_WIRE_LIMIT);
  assert.equal(report.passed, true);
  assert.notEqual(
    expected,
    gzipSync(Buffer.concat(report.initial.files.map((path) => input.files.get(path))), { level: 9 }).length,
  );
});

test("route raw boundary is inclusive even for extremely compressible JavaScript", () => {
  const input = fixture();
  input.files.set("assets/route.js", Buffer.alloc(ROUTE_RAW_LIMIT, " "));
  assert.equal(analyze(input).passed, true);
  input.files.set("assets/route.js", Buffer.alloc(ROUTE_RAW_LIMIT + 1, " "));
  const report = analyze(input);
  assert.equal(report.initial.passed, true);
  assert.equal(route(report).rawBytes, ROUTE_RAW_LIMIT + 1);
  assert.ok(route(report).gzipBytes < 1_000);
  assert.equal(route(report).passed, false);
  assert.equal(report.passed, false);
});

test("cycles and repeated shared files do not double count or recurse forever", () => {
  const input = fixture();
  input.manifest["index.html"].imports.push("_shared.js");
  input.manifest["_shared.js"].imports = ["index.html"];
  input.manifest["src/route.js"].imports.push("_helper.js", "_helper.js");
  input.manifest["_helper.js"] = {
    file: "assets/helper.js",
    imports: ["src/route.js"],
    css: ["assets/shell.css", "assets/shell.css"],
    assets: ["assets/picture.png", "assets/picture.png"],
  };
  input.files.set("assets/helper.js", Buffer.from("helper();"));
  input.files.set("assets/picture.png", Buffer.alloc(20));
  const report = analyze(input);
  assert.deepEqual(route(report).files, ["assets/helper.js", "assets/picture.png", "assets/route.js"]);
  assert.equal(route(report).rawBytes, 37);
  assert.equal(report.initial.files.length, 4);
});

test("splitting a route into static chunks cannot evade the raw route limit", () => {
  const input = fixture();
  input.manifest["src/route.js"].imports.push("_split.js");
  input.manifest["_split.js"] = { file: "assets/split.js" };
  input.files.set("assets/route.js", Buffer.alloc(140_000, " "));
  input.files.set("assets/split.js", Buffer.alloc(140_000, " "));
  const report = analyze(input);
  assert.equal(route(report).rawBytes, 280_000);
  assert.equal(report.passed, false);
});

test("uncached nested dynamic chunks form a conservative route envelope but cached shell routes stop", () => {
  const input = fixture();
  input.manifest["src/route.js"].dynamicImports = ["src/optional.js"];
  input.manifest["src/optional.js"] = {
    file: "assets/optional.js",
    isDynamicEntry: true,
    imports: ["_shared.js"],
    dynamicImports: ["src/route.js"],
  };
  input.manifest["_shared.js"].dynamicImports = ["src/unrelated.js"];
  input.manifest["src/unrelated.js"] = { file: "assets/unrelated.js", isDynamicEntry: true };
  input.files.set("assets/route.js", Buffer.alloc(140_000, " "));
  input.files.set("assets/optional.js", Buffer.alloc(140_000, " "));
  input.files.set("assets/unrelated.js", Buffer.alloc(200_000, " "));
  const report = analyze(input);
  assert.deepEqual(route(report).files, ["assets/optional.js", "assets/route.js"]);
  assert.equal(route(report).rawBytes, 280_000);
  assert.equal(route(report).passed, false);
  assert.equal(route(report, "src/unrelated.js").passed, true);
  assert.equal(report.initial.passed, true, "initial traversal never follows dynamic imports");
});

test("extra HTML preloads, CSS imports, fonts, image-set, srcset and inline styles are included", () => {
  const input = fixture();
  input.files.set(
    "index.html",
    Buffer.from(`${input.files.get("index.html")}
    <link rel="modulepreload" href="/app/assets/extra.js?version=1#ignored">
    <link rel="stylesheet" href="/app/assets/extra.css">
    <img srcset="data:image/png;base64,AAAA 1x, /app/images/picture.png 2x">
    <div style="background:url('/app/images/inline.png')"></div>
    <style>.a{mask:url(data:image/svg+xml,%3Csvg%3E)}</style>`),
  );
  input.manifest["_extra.js"] = { file: "assets/extra.js", imports: ["_extra-helper.js"] };
  input.manifest["_extra-helper.js"] = { file: "assets/extra-helper.js" };
  for (const name of [
    "assets/extra.js",
    "assets/extra-helper.js",
    "assets/font.woff2",
    "images/picture.png",
    "images/inline.png",
    "images/tile.png",
  ])
    input.files.set(name, Buffer.alloc(5, " "));
  input.files.set(
    "assets/extra.css",
    Buffer.from(String.raw`
    @import "./nested/base.css";
    .font{src:u\72l("./font.woff2")}
    .picture{background-image:image-set("../images/picture.png" 1x,url('../images/tile.png') 2x)}
    /* url(https://not-fetched.invalid/comment.png) */
    .text{content:"url(https://not-fetched.invalid/string.png)"}
  `),
  );
  input.files.set("assets/nested/base.css", Buffer.from('@import "../extra.css"; .local{mask:url(#shape)}'));
  const report = analyze(input);
  for (const name of [
    "assets/extra.js",
    "assets/extra-helper.js",
    "assets/extra.css",
    "assets/nested/base.css",
    "assets/font.woff2",
    "images/picture.png",
    "images/inline.png",
    "images/tile.png",
  ]) {
    assert.ok(report.initial.files.includes(name), `unaccounted asset ${name}`);
  }
  assert.equal(report.initial.files.filter((name) => name === "images/picture.png").length, 1);
});

test("HTML JavaScript outside the manifest cannot conceal its import closure", () => {
  for (const name of ["unlisted.js", "unlisted.mjs", "unlisted-script"]) {
    const input = fixture();
    input.files.set("index.html", Buffer.from(`<script src="/app/assets/${name}"></script>`));
    input.files.set(`assets/${name}`, Buffer.from("import './hidden.js'"));
    assert.throws(() => analyze(input), /missing manifest record/u);
  }
});

test("a descriptor-less data srcset candidate cannot hide a following large external-file candidate", () => {
  const input = fixture();
  input.files.set(
    "index.html",
    Buffer.from(
      `${input.files.get("index.html")}<img srcset="data:image/png;base64,iVBORw0KGgo=, /app/images/large.png 2x">`,
    ),
  );
  input.files.set("images/large.png", Buffer.alloc(400_001));
  const report = analyze(input);
  assert.ok(report.initial.files.includes("images/large.png"));
  assert.ok(report.initial.wireBytes > INITIAL_WIRE_LIMIT);
  assert.equal(report.passed, false);
});

test("emitted static imports, export-from and literal dynamic imports must match manifest edges", () => {
  const input = fixture();
  input.files.set(
    "assets/index.js",
    Buffer.from('import "./shared.js"; export { value } from "./shared.js"; import("./route.js");'),
  );
  input.files.set("assets/shared.js", Buffer.from("export const value = 1;"));
  assert.equal(analyze(input).passed, true);
  input.manifest["index.html"].imports = [];
  assert.throws(() => analyze(input), /imports missing manifest edge/u);
  input.manifest["index.html"].imports = ["_shared.js"];
  input.manifest["index.html"].dynamicImports = [];
  assert.throws(() => analyze(input), /dynamicImports missing manifest edge/u);
});

test("emitted external modules omitted by Vite manifests fail without mistaking ordinary API URLs", () => {
  for (const source of [
    'import "https://outside.invalid/module.js";',
    'export { value } from "https://outside.invalid/module.js";',
    'import("https://outside.invalid/module.js");',
    'new Worker(new URL("https://outside.invalid/worker.js", import.meta.url));',
    'new URL("https://outside.invalid/image.png", import.meta.url);',
  ]) {
    const input = fixture();
    input.files.set("assets/index.js", Buffer.from(source));
    assert.throws(() => analyze(input), /external resource URL/u, source);
  }
  const ordinary = fixture();
  ordinary.files.set(
    "assets/index.js",
    Buffer.from(
      'fetch("https://api.example.invalid/v1"); new URL("https://api.example.invalid", location.href); const text="import(unknown)";',
    ),
  );
  assert.equal(analyze(ordinary).passed, true);
});

test("literal import.meta.url assets are counted and module syntax/path failures are closed", () => {
  const input = fixture();
  input.files.set(
    "assets/route.js",
    Buffer.from(
      'new URL("../images/picture.png", import.meta.url); new URL("data:image/png;base64,AAAA", import.meta.url);',
    ),
  );
  input.files.set("images/picture.png", Buffer.alloc(30));
  assert.ok(route(analyze(input)).files.includes("images/picture.png"));
  for (const source of ['import("./missing.js");', "export const = ;"]) {
    input.files.set("assets/route.js", Buffer.from(source));
    assert.throws(() => analyze(input), /missing manifest record|invalid JavaScript syntax/u);
  }
  for (const extension of ["mjs", "cjs"]) {
    const other = fixture();
    other.manifest["src/route.js"].file = `assets/route.${extension}`;
    other.files.set(`assets/route.${extension}`, Buffer.from('import("https://outside.invalid/module.js")'));
    assert.throws(() => analyze(other), /external resource URL/u);
  }
});

test("computed runtime references are explicitly reported without source values or a completeness claim", () => {
  const input = fixture();
  input.files.set(
    "assets/index.js",
    Buffer.from(
      'const candidate = "private-runtime-module-value"; import(candidate); import(`${candidate}.js`); new URL(candidate, import.meta.url); new URL(candidate, location.href);',
    ),
  );
  const report = analyze(input);
  assert.equal(report.passed, true);
  assert.deepEqual(report.unresolvedRuntimeReferences, [
    { file: "assets/index.js", kind: "dynamic-import", count: 2 },
    { file: "assets/index.js", kind: "import-meta-url", count: 1 },
  ]);
  assert.ok(!JSON.stringify(report).includes("private-runtime-module-value"));
  assert.match(report.accounting, /not resolved or measured/u);
  input.files.set(
    "assets/index.js",
    Buffer.from('import(candidate); import("https://outside.invalid/private-key");'),
  );
  assert.throws(
    () => analyze(input),
    (error) => /external resource URL/u.test(error.message) && !error.message.includes("private-key"),
  );
});

test("malformed schema, missing entries, referenced records and files fail closed", () => {
  const changes = [
    (x) => {
      x.manifest = null;
    },
    (x) => {
      x.manifest = [];
    },
    (x) => {
      x.manifest = {};
    },
    (x) => {
      delete x.manifest["index.html"];
    },
    (x) => {
      x.manifest["index.html"].isEntry = false;
    },
    (x) => {
      x.manifest["src/route.js"].isDynamicEntry = false;
    },
    (x) => {
      x.manifest["src/route.js"] = null;
    },
    (x) => {
      x.manifest["index.html"].isEntry = "true";
    },
    (x) => {
      x.manifest["index.html"].imports = "_shared.js";
    },
    (x) => {
      x.manifest["index.html"].css = [12];
    },
    (x) => {
      x.manifest["index.html"].unknown = [];
    },
    (x) => {
      delete x.manifest["index.html"].file;
    },
    (x) => {
      x.manifest["index.html"].imports = ["missing.js"];
    },
    (x) => {
      x.manifest["src/route.js"].dynamicImports = ["missing.js"];
    },
    (x) => {
      x.files.delete("index.html");
    },
    (x) => {
      x.files.delete("assets/route.js");
    },
    (x) => {
      x.manifest["unused.js"] = { file: "assets/missing.js" };
    },
    (x) => {
      x.manifest["index.html"].assets = ["assets/missing.png"];
    },
  ];
  for (const change of changes) {
    const input = fixture();
    change(input);
    assert.throws(() => analyze(input), undefined, change.toString());
  }
});

test("manifest paths, external HTML/CSS URLs and encoded escapes fail closed", () => {
  for (const path of [
    "../outside.js",
    "/tmp/outside.js",
    "https://outside.invalid/a.js",
    "C:\\outside.js",
    "assets\\file.js",
    "assets/%2e%2e/file.js",
    "assets//file.js",
  ]) {
    const input = fixture();
    input.manifest["src/route.js"].file = path;
    assert.throws(() => analyze(input), /invalid relative path/u, path);
  }
  for (const url of [
    "https://outside.invalid/font.woff2",
    "//outside.invalid/font.woff2",
    "../../outside.png",
    "%2e%2e/%2e%2e/outside.png",
    "/app/../outside.png",
    "/other.png",
    "/app/%5coutside.png",
    "blob:outside",
    "%not-an-escape",
  ]) {
    const input = fixture();
    input.files.set("assets/shell.css", Buffer.from(`a{background:url('${url}')}`));
    assert.throws(() => analyze(input), undefined, url);
  }
  for (const html of [
    '<link rel="preload" href="https://outside.invalid/font.woff2">',
    '<script src="//outside.invalid/a.js"></script>',
    '<link rel="icon" href="/not-favicon.ico">',
    '<link rel="stylesheet" href="/favicon.ico">',
    '<base href="/app/">',
  ]) {
    const input = fixture();
    input.files.set("index.html", Buffer.from(html));
    assert.throws(() => analyze(input), undefined, html);
  }
});

function diskFixture(t, input = fixture(), name = "dist") {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-bundle-budget-test-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const dist = join(cwd, name);
  for (const [file, data] of input.files) {
    const target = join(dist, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
  }
  mkdirSync(join(dist, ".vite"), { recursive: true });
  writeFileSync(join(dist, ".vite/manifest.json"), JSON.stringify(input.manifest));
  return { cwd, dist };
}

function run(cwd, args = [], env = process.env) {
  return spawnSync(process.execPath, [script, ...args], { cwd, env, encoding: "utf8", timeout: 10_000 });
}

function runBuild(cwd, args = [], env = process.env) {
  return spawnSync(process.execPath, [buildScript, ...args], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
}

test("CLI supports default and selected dist, emits JSON plus diagnostics and writes no report itself", (t) => {
  const { cwd } = diskFixture(t);
  const result = run(cwd);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).passed, true);
  assert.match(result.stderr, /번들 예산 통과/u);
  assert.equal(existsSync(join(cwd, "bundle-budget-report.json")), false);
  const custom = diskFixture(t, fixture(), "other-dist");
  const selected = run(custom.cwd, [custom.dist]);
  assert.equal(selected.status, 0, selected.stderr);
  assert.deepEqual(JSON.parse(selected.stdout), JSON.parse(result.stdout));
});

test("CLI budget failure still emits a report and neither flags nor env can relax limits", (t) => {
  const input = fixture();
  input.files.set("assets/route.js", Buffer.alloc(ROUTE_RAW_LIMIT + 1, " "));
  const { cwd } = diskFixture(t, input);
  const result = run(cwd, [], {
    ...process.env,
    ROUTE_RAW_LIMIT: "999999999",
    INITIAL_WIRE_LIMIT: "999999999",
  });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).passed, false);
  assert.match(result.stderr, /번들 예산 초과/u);
  for (const args of [["--route-limit=999999999"], ["dist", "999999999"], ["--silent"], ["--quiet"]]) {
    const invalid = run(cwd, args);
    assert.equal(invalid.status, 1);
    assert.equal(invalid.stdout, "");
    assert.match(invalid.stderr, /usage:/u);
  }
});

test("CLI schema/file failures emit no stale success report; symlink escapes and directories fail", (t) => {
  const invalidJSON = diskFixture(t);
  writeFileSync(join(invalidJSON.dist, ".vite/manifest.json"), "not JSON");
  const missing = diskFixture(t);
  rmSync(join(missing.dist, "assets/route.js"));
  const directory = diskFixture(t);
  rmSync(join(directory.dist, "assets/route.js"));
  mkdirSync(join(directory.dist, "assets/route.js"));
  const escaped = diskFixture(t);
  writeFileSync(join(escaped.cwd, "outside.js"), "not in dist");
  rmSync(join(escaped.dist, "assets/route.js"));
  symlinkSync(join(escaped.cwd, "outside.js"), join(escaped.dist, "assets/route.js"));
  for (const input of [invalidJSON, missing, directory, escaped]) {
    const result = run(input.cwd);
    assert.equal(result.status, 1, result.stdout);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /번들 예산 검사 실패/u);
  }
  assert.match(run(escaped.cwd).stderr, /escapes dist/u);
  assert.match(run(directory.cwd).stderr, /expected regular file/u);
});

test("build wrapper strips trailing quiet flags without changing JSON or diagnostics", (t) => {
  const { cwd, dist } = diskFixture(t);
  const direct = run(cwd);
  for (const args of [[], ["--silent"], ["--quiet"], ["-s", "-q"], [dist, "--silent", "--quiet"]]) {
    const result = runBuild(cwd, args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, direct.stdout);
    assert.equal(result.stderr, direct.stderr);
  }
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(
    manifest.scripts.build,
    /&& node scripts\/build-bundle-budget\.mjs > bundle-budget-report\.json$/u,
    "the package build must finish with the quiet-compatible wrapper",
  );
  assert.equal(manifest.scripts["bundle:check"], "node scripts/check-bundle-budget.mjs");
});

test("quiet build wrapper preserves budget failures, fixed limits and invalid-argument errors", (t) => {
  const input = fixture();
  input.files.set("assets/route.js", Buffer.alloc(ROUTE_RAW_LIMIT + 1, " "));
  const { cwd } = diskFixture(t, input);
  const direct = run(cwd);
  const result = runBuild(cwd, ["--silent", "--quiet"], {
    ...process.env,
    ROUTE_RAW_LIMIT: "999999999",
    INITIAL_WIRE_LIMIT: "999999999",
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, direct.stdout);
  assert.equal(result.stderr, direct.stderr);
  assert.equal(JSON.parse(result.stdout).passed, false);
  for (const args of [
    ["--route-limit=999999999", "--silent"],
    ["--quiet", "dist"],
    ["dist", "other", "-q"],
  ]) {
    const invalid = runBuild(cwd, args);
    assert.equal(invalid.status, 1);
    assert.equal(invalid.stdout, "");
    assert.match(invalid.stderr, /usage:/u);
  }
});

test("quiet build wrapper preserves structural failures without a success report", (t) => {
  const { cwd, dist } = diskFixture(t);
  writeFileSync(join(dist, ".vite/manifest.json"), "not JSON");
  const direct = run(cwd);
  const result = runBuild(cwd, ["--silent"]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, direct.stderr);
});
