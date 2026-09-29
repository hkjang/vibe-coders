import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const merger = fileURLToPath(
  new URL("./merge-source-sbom.mjs", import.meta.url),
);

function dependency(name, ecosystem, version = "1.2.3") {
  return {
    name,
    versionInfo: version,
    externalRefs: [
      {
        referenceType: "purl",
        referenceLocator: `pkg:${ecosystem}/${name}@${version}`,
      },
    ],
  };
}

for (const rootPurl of [
  "pkg:golang/vibe-coders",
  "pkg:golang/vibe-coders@v0.86.1+dirty",
]) {
  test(`merger excludes self ${rootPurl} and preserves similarly named dependencies`, (t) => {
    const directory = mkdtempSync(join(tmpdir(), "merge-source-sbom-test-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));

    const goDependencies = [
      dependency("example.com/vibe-coders", "golang"),
      dependency("vibe-coders-helper", "golang"),
      ...Array.from({ length: 13 }, (_, index) =>
        dependency(`example.com/dependency-${index}`, "golang"),
      ),
    ];
    const npmDependencies = [
      dependency("react", "npm"),
      ...Array.from({ length: 49 }, (_, index) =>
        dependency(`dependency-${index}`, "npm"),
      ),
    ];
    const root = {
      name: "vibe-coders",
      versionInfo: rootPurl.includes("@") ? "v0.86.1+dirty" : "UNKNOWN",
      externalRefs: [{ referenceType: "purl", referenceLocator: rootPurl }],
    };
    const inputPaths = ["go.json", "npm.json", "npm-licenses.json"].map(
      (name) => join(directory, name),
    );
    const inputs = [
      { packages: [root, ...goDependencies] },
      { packages: npmDependencies },
      {},
    ];
    inputs.forEach((input, index) =>
      writeFileSync(inputPaths[index], JSON.stringify(input)),
    );
    const sbomPath = join(directory, "SBOM.spdx.json");
    const licensesPath = join(directory, "THIRD_PARTY_LICENSES.md");

    const result = spawnSync(
      process.execPath,
      [merger, "v0.86.1", ...inputPaths, sbomPath, licensesPath],
      {
        encoding: "utf8",
        env: { ...process.env, SOURCE_DATE_EPOCH: "1788338853" },
      },
    );
    assert.equal(result.status, 0, result.stderr);

    const sbom = JSON.parse(readFileSync(sbomPath, "utf8"));
    const selfPackages = sbom.packages.filter(
      (pkg) => pkg.name === "vibe-coders",
    );
    assert.equal(selfPackages.length, 1);
    assert.equal(selfPackages[0].SPDXID, "SPDXRef-Package-vibe-coders");
    assert.equal(selfPackages[0].versionInfo, "0.86.1");
    const expectedPurls = [...goDependencies, ...npmDependencies]
      .map((pkg) => pkg.externalRefs[0].referenceLocator)
      .sort();
    const dependencies = sbom.packages.filter(
      (pkg) => pkg.SPDXID !== selfPackages[0].SPDXID,
    );
    assert.deepEqual(
      dependencies.map((pkg) => pkg.externalRefs[0].referenceLocator).sort(),
      expectedPurls,
    );
    assert.deepEqual(
      sbom.relationships
        .filter(
          (relationship) => relationship.relationshipType === "DEPENDS_ON",
        )
        .map((relationship) => relationship.relatedSpdxElement)
        .sort(),
      dependencies.map((pkg) => pkg.SPDXID).sort(),
    );

    const licenses = readFileSync(licensesPath, "utf8");
    assert.doesNotMatch(licenses, /\| `vibe-coders` \|/);
    assert.match(licenses, /\| `example\.com\/vibe-coders` \| 1\.2\.3 \|/);
    assert.match(licenses, /\| `vibe-coders-helper` \| 1\.2\.3 \|/);
  });
}
