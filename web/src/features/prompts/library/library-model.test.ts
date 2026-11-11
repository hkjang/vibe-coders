import { describe, expect, it } from "vitest";
import {
  libraryAssetSchema,
  librarySearchSchema,
  projectLibrary,
  hiddenLibraryText,
  libraryNumber,
  libraryCost,
  libraryPercent,
} from "./library-model";
import { assetPatch, assetFormValues, assetSlug, newAssetID } from "./asset-form";
import { diffPromptBodies, canSubmitAsset } from "./prompt-utils";
import { filterQueryString, searchQueryFrom, searchUpdatesFrom, localSearchTime } from "./search-filters";
import { libraryCsvHeaders, projectLibraryCsv } from "./library-csv";
import { toCsv } from "@/shared/utils/csv";

const prefixes = ["public_credential_"];
const asset = {
  id: "public-template",
  name: "공개 테스트 자산",
  body: "public_credential_example123456789012345678901234567890",
  category: "custom",
  status: "draft",
  tags: ["public"],
  note: "",
};
describe("프롬프트 보관함 표시와 저장 계약", () => {
  it("drops undeclared and nested raw payloads before caching while masking configured credentials", () => {
    const projected = projectLibrary(
      librarySearchSchema,
      {
        requests: [
          {
            id: "public-request",
            raw_body: "not-a-displayed-field",
            prompts: [
              {
                role: "user",
                raw_text: "not-a-displayed-field",
                redacted_text: "public_credential_example123456789012345678901234567890",
              },
            ],
            languages: [{ language: "한국어", private_extra: "not-a-displayed-field" }],
          },
        ],
      },
      prefixes,
    );
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain("not-a-displayed-field");
    expect(serialized).not.toContain("public_credential_example123456789012345678901234567890");
    expect(projected.requests?.[0]?.prompts?.[0]?.redacted_text).toBe(hiddenLibraryText);
  });
  it("preserves a masked stored body when editing only the name, never replacing it with a placeholder", () => {
    const projected = projectLibrary(libraryAssetSchema, asset, prefixes);
    const values = { ...assetFormValues(projected), name: "변경 이름" };
    expect(assetPatch(values, projected)).toEqual({ name: "변경 이름" });
    expect(() => assetPatch({ ...values, body: `${hiddenLibraryText} 추가` }, projected)).toThrow();
  });
  it("supports intentionally clearing tags and notes without resetting review status", () => {
    const previous = { ...asset, body: "일반 본문", note: "이전 메모" };
    expect(
      assetPatch({ ...assetFormValues(previous), tags: "", note: "", status: "standard" }, previous),
    ).toEqual({ tags: [], note: "" });
  });
  it("matches the server slug and requires an explicit ID for all-Korean names", () => {
    expect(assetSlug(" Public__Asset--A / B ")).toBe("public__asset--a-b");
    expect(newAssetID({ ...assetFormValues(asset), id: "", name: "한글 이름" })).toBe("");
  });
  it("keeps missing measurements distinct from measured zero", () => {
    expect([libraryNumber(undefined), libraryCost(null), libraryPercent(undefined)]).toEqual(["—", "—", "—"]);
    expect(libraryNumber(0)).toBe("0");
    expect(libraryPercent(0)).toBe("0.0%");
  });
  it("shows moved and repeated lines instead of treating both bodies as equal", () => {
    expect(diffPromptBodies("첫째\n둘째", "둘째\n첫째")).toHaveLength(4);
    expect(diffPromptBodies("반복\n반복", "반복")).toEqual([{ key: "-1", text: "반복", tone: "removed" }]);
    expect(diffPromptBodies("동일", "동일")).toEqual([]);
    expect(canSubmitAsset(undefined)).toBe(false);
  });
});
describe("검색 조건과 CSV", () => {
  it("caps search to the existing API limit and preserves a timezone-qualified instant", () => {
    const params = new URLSearchParams({ since: "2030-01-01T09:30:00+09:00", limit: "10000", q: "요약" });
    expect(searchQueryFrom(params)).toEqual({ limit: 100, q: "요약", since: "2030-01-01T00:30:00.000Z" });
    expect(new URLSearchParams(filterQueryString(params)).get("since")).toBe("2030-01-01T00:30:00.000Z");
    expect(localSearchTime("invalid")).toBe("");
    expect(searchQueryFrom(new URLSearchParams({ limit: "200" })).limit).toBe(200);
  });
  it.each(["q", "language", "ip", "api_key_id", "since"])(
    "rejects credentials in %s before URL or saved-filter writes",
    (key) => {
      expect(() =>
        searchUpdatesFrom(
          new URLSearchParams({ [key]: "public_credential_example123456789012345678901234567890" }),
          prefixes,
        ),
      ).toThrow();
    },
  );
  it("rejects invalid time and ignores unsupported saved filter fields", () => {
    expect(() => searchUpdatesFrom(new URLSearchParams({ since: "invalid" }), prefixes)).toThrow();
    expect(
      searchUpdatesFrom(new URLSearchParams({ asset: "other", q: "safe" }), prefixes),
    ).not.toHaveProperty("asset");
  });
  it("handles BOM, commas, quotes and multiline cells, removes credentials and neutralizes formula cells", () => {
    const row = Array.from({ length: 21 }, () => "");
    row[0] = "2030-01-01T00:00:00Z";
    row[4] = '공개, "공급자"';
    row[5] = "public_credential_example123456789012345678901234567890";
    row[20] = "첫 줄\n둘째 줄";
    const csv = toCsv(
      [row],
      libraryCsvHeaders.map((header, index) => ({ header, value: (entry: string[]) => entry[index] })),
    );
    const projected = projectLibraryCsv(csv, prefixes);
    expect(projected).toContain('"공개, ""공급자"""');
    expect(projected).toContain('"첫 줄\n둘째 줄"');
    expect(projected).toContain(hiddenLibraryText);
    expect(projected).not.toContain("public_credential_example123456789012345678901234567890");
    const raw =
      libraryCsvHeaders.join(",") + "\n" + ["=1+1", ...Array.from({ length: 20 }, () => "")].join(",");
    expect(projectLibraryCsv(raw, prefixes)).toContain("'=1+1");
  });
  it.each([
    "<html>login</html>",
    "a,b\n1,2",
    `${libraryCsvHeaders.join(",")}\nshort,row`,
    `${libraryCsvHeaders.join(",")}\n"unterminated`,
    `${libraryCsvHeaders.join(",")}\n"closed"extra`,
  ])("rejects malformed exports instead of downloading them", (csv) => {
    expect(() => projectLibraryCsv(csv, prefixes)).toThrow();
  });
});
