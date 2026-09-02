#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

function fail(message) {
  console.error(`SBOM merge failed: ${message}`);
  process.exit(1);
}

const [rawVersion, goPath, npmPath, npmLicensesPath, outputPath, licensesOutputPath] = process.argv.slice(2);
if (!rawVersion || !goPath || !npmPath || !npmLicensesPath || !outputPath || !licensesOutputPath) {
  fail(
    "usage: merge-source-sbom.mjs VERSION GO_SPDX NPM_SPDX NPM_LICENSES_JSON OUTPUT_SPDX OUTPUT_LICENSES",
  );
}

const version = rawVersion.replace(/^v/, "");
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) fail(`invalid version ${rawVersion}`);

function readJSON(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function packagePurl(pkg, prefix) {
  const refs = Array.isArray(pkg.externalRefs) ? pkg.externalRefs : [];
  return refs
    .map((ref) => ref?.referenceLocator)
    .find((locator) => typeof locator === "string" && locator.startsWith(prefix));
}

function stableID(ecosystem, name, purl) {
  const slug = name.replace(/[^A-Za-z0-9.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "dependency";
  const digest = createHash("sha256").update(purl).digest("hex").slice(0, 16);
  return `SPDXRef-Package-${ecosystem}-${slug}-${digest}`;
}

const knownGoLicenses = new Map(
  Object.entries({
    "filippo.io/edwards25519": "BSD-3-Clause",
    "github.com/dustin/go-humanize": "MIT",
    "github.com/go-sql-driver/mysql": "MPL-2.0",
    "github.com/google/uuid": "BSD-3-Clause",
    "github.com/jackc/pgpassfile": "MIT",
    "github.com/jackc/pgservicefile": "MIT",
    "github.com/jackc/pgx/v5": "MIT",
    "github.com/jackc/puddle/v2": "MIT",
    "github.com/remyoudompheng/bigfft": "BSD-3-Clause",
    "github.com/sijms/go-ora/v2": "MIT",
    "golang.org/x/crypto": "BSD-3-Clause",
    "golang.org/x/sync": "BSD-3-Clause",
    "golang.org/x/sys": "BSD-3-Clause",
    "golang.org/x/text": "BSD-3-Clause",
    "modernc.org/libc": "BSD-3-Clause",
    "modernc.org/mathutil": "BSD-3-Clause",
    "modernc.org/memory": "BSD-3-Clause",
    "modernc.org/sqlite": "BSD-3-Clause",
    stdlib: "BSD-3-Clause",
  }),
);

const npmLicenseReport = readJSON(npmLicensesPath);
const npmLicenses = new Map();
for (const [license, entries] of Object.entries(npmLicenseReport)) {
  if (!Array.isArray(entries)) continue;
  const normalized = /^[A-Za-z0-9.+-]+(?:\s+(?:AND|OR)\s+[A-Za-z0-9.+-]+)*$/.test(license)
    ? license
    : "NOASSERTION";
  for (const entry of entries) {
    if (typeof entry?.name !== "string" || !Array.isArray(entry.versions)) continue;
    for (const entryVersion of entry.versions) {
      npmLicenses.set(`${entry.name}@${entryVersion}`, normalized);
    }
  }
}

function normalizePackage(pkg, ecosystem, purl) {
  const name = String(pkg.name ?? "");
  const packageVersion = String(pkg.versionInfo ?? "");
  const license =
    ecosystem === "go"
      ? (knownGoLicenses.get(name) ?? pkg.licenseDeclared ?? "NOASSERTION")
      : (npmLicenses.get(`${name}@${packageVersion}`) ?? pkg.licenseDeclared ?? "NOASSERTION");
  return {
    name,
    SPDXID: stableID(ecosystem, name, purl),
    versionInfo: packageVersion,
    downloadLocation: pkg.downloadLocation || "NOASSERTION",
    filesAnalyzed: false,
    licenseConcluded: license,
    licenseDeclared: license,
    copyrightText: pkg.copyrightText || "NOASSERTION",
    externalRefs: [
      {
        referenceCategory: "PACKAGE-MANAGER",
        referenceType: "purl",
        referenceLocator: purl,
      },
    ],
  };
}

function collect(document, ecosystem, prefix) {
  const byPurl = new Map();
  for (const pkg of document.packages ?? []) {
    const purl = packagePurl(pkg, prefix);
    if (!purl || purl.includes("/vibe-coders@") || pkg.name === "vibe-coders-app") continue;
    if (!byPurl.has(purl)) byPurl.set(purl, normalizePackage(pkg, ecosystem, purl));
  }
  return [...byPurl.values()].sort((left, right) =>
    `${left.name}@${left.versionInfo}`.localeCompare(`${right.name}@${right.versionInfo}`, "en"),
  );
}

const goPackages = collect(readJSON(goPath), "go", "pkg:golang/");
const npmPackages = collect(readJSON(npmPath), "npm", "pkg:npm/");
if (goPackages.length < 15) fail(`Go SBOM is unexpectedly small (${goPackages.length} packages)`);
if (npmPackages.length < 50) fail(`frontend SBOM is unexpectedly small (${npmPackages.length} packages)`);
if (!npmPackages.some((pkg) => pkg.name === "react")) fail("frontend SBOM does not contain React");

const rootID = "SPDXRef-Package-vibe-coders";
const rootPackage = {
  name: "vibe-coders",
  SPDXID: rootID,
  versionInfo: version,
  downloadLocation: `git+https://github.com/hkjang/vibe-coders.git@v${version}`,
  filesAnalyzed: false,
  licenseConcluded: "AGPL-3.0-only",
  licenseDeclared: "AGPL-3.0-only",
  copyrightText: "Copyright (c) 2026 hkjang and vibe-coders contributors",
  externalRefs: [
    {
      referenceCategory: "PACKAGE-MANAGER",
      referenceType: "purl",
      referenceLocator: `pkg:golang/vibe-coders@${version}`,
    },
  ],
};

const created = process.env.SOURCE_DATE_EPOCH
  ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z")
  : new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const dependencies = [...goPackages, ...npmPackages];
const document = {
  spdxVersion: "SPDX-2.3",
  dataLicense: "CC0-1.0",
  SPDXID: "SPDXRef-DOCUMENT",
  name: `vibe-coders-v${version}-integrated-source-sbom`,
  documentNamespace: `https://github.com/hkjang/vibe-coders/sbom/v${version}`,
  creationInfo: {
    created,
    creators: ["Tool: Syft-1.51.0", "Tool: scripts/merge-source-sbom.mjs", "Organization: vibe-coders contributors"],
    comment:
      "Integrated dependency inventory for the linked Go gateway binary and the pnpm-locked React frontend build graph. Container OS packages require a separate final-image scan.",
  },
  documentDescribes: [rootID],
  packages: [rootPackage, ...dependencies],
  relationships: [
    {
      spdxElementId: "SPDXRef-DOCUMENT",
      relationshipType: "DESCRIBES",
      relatedSpdxElement: rootID,
    },
    ...dependencies.map((pkg) => ({
      spdxElementId: rootID,
      relationshipType: "DEPENDS_ON",
      relatedSpdxElement: pkg.SPDXID,
    })),
  ],
};
writeFileSync(outputPath, `${JSON.stringify(document, null, 2)}\n`);

function markdownCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

const directManifest = readJSON(new URL("../web/package.json", import.meta.url));
const runtimeDirect = new Set(Object.keys(directManifest.dependencies ?? {}));
const buildDirect = new Set(Object.keys(directManifest.devDependencies ?? {}));
const lines = [
  "# Third-party licenses",
  "",
  `이 문서는 Vibe Coders v${version}의 Go 실행 바이너리와 pnpm 잠금 그래프를 기준으로 생성한 통합 의존성 목록입니다.`,
  "React 운영 번들 의존성과 Frontend 빌드·테스트 도구를 함께 포함하며, 전체 라이선스 원문과 저작권 표시는 각 배포 패키지의 `LICENSE*` 파일을 따릅니다.",
  "",
  "## Go gateway dependencies",
  "",
  "| 구성요소 | 버전 | 라이선스 |",
  "| --- | --- | --- |",
  ...goPackages.map(
    (pkg) =>
      `| \`${markdownCell(pkg.name)}\` | ${markdownCell(pkg.versionInfo)} | ${markdownCell(pkg.licenseDeclared)} |`,
  ),
  "",
  "## React / npm dependency graph",
  "",
  "| 구성요소 | 버전 | 라이선스 | 범위 |",
  "| --- | --- | --- | --- |",
  ...npmPackages.map((pkg) => {
    const scope = runtimeDirect.has(pkg.name)
      ? "runtime direct"
      : buildDirect.has(pkg.name)
        ? "build/test direct"
        : "transitive";
    return `| \`${markdownCell(pkg.name)}\` | ${markdownCell(pkg.versionInfo)} | ${markdownCell(pkg.licenseDeclared)} | ${scope} |`;
  }),
  "",
  "## Scope and verification",
  "",
  "- `/app`은 모든 JavaScript, CSS, 아이콘을 Go 바이너리에 embed하며 런타임 CDN이나 Node.js를 요구하지 않습니다.",
  "- `NOASSERTION`은 잠금 파일 또는 설치 메타데이터에서 SPDX 식을 확정하지 못했다는 뜻이며, 무라이선스를 의미하지 않습니다.",
  "- 최종 Distroless 이미지의 운영체제 구성요소는 릴리스 이미지 digest를 대상으로 별도 Syft 스캔해야 합니다.",
  "- `seed.sql`, `.gitframe/`, `output/`은 릴리스 및 커밋 범위에서 제외됩니다.",
  "",
  "재생성: `scripts/generate-source-sbom.sh v" + version + "`",
];
writeFileSync(licensesOutputPath, `${lines.join("\n")}\n`);

console.log(`integrated SBOM written: ${goPackages.length} Go + ${npmPackages.length} npm packages`);
