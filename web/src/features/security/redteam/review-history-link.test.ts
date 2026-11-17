import { describe, expect, it } from "vitest";
import { reviewHistoryLink } from "./review-history-link";
import { readRunQuery, runQueryKeys } from "@/shared/utils/redteam-run-query";

describe("검토별 실행 이력 이동", () => {
  it("이전 페이지·상태·재실행·기간·상세 조건을 지우고 정확한 캠페인과 검토로 조회한다", () => {
    const link = reviewHistoryLink("v0.86.148", "campaign-공개", "rtreview-public", []);
    expect(link).toBeDefined();
    const params = new URLSearchParams(runQueryKeys.map((key) => [key, "old"]));
    for (const [key, value] of Object.entries(link ?? {})) {
      if (value == null) params.delete(key);
      else params.set(key, String(value));
    }
    const search = readRunQuery(params, []);
    expect(search.valid).toBe(true);
    expect(search.selected).toBe("");
    expect(search.query).toEqual({
      view: "page",
      limit: 25,
      offset: 0,
      kind: "campaign",
      campaign_id: "campaign-공개",
      review_id: "rtreview-public",
    });
    expect(params.get("tab")).toBe("runs");
  });
  it.each(["v0.86.147", "", "unknown"])(
    "검토 ID를 기록하지 않는 %s 서버에서는 링크를 만들지 않는다",
    (version) => {
      expect(reviewHistoryLink(version, "campaign", "review", [])).toBeUndefined();
    },
  );
  it.each(["", "bad/id", "bad?reason=text", "a".repeat(257), "org-" + "a".repeat(32)])(
    "유효하지 않거나 자격 증명 형식인 ID를 URL에 넣지 않는다: %s",
    (id) => {
      expect(reviewHistoryLink("v0.86.148", "campaign", id, ["org-"])).toBeUndefined();
      expect(reviewHistoryLink("v0.86.148", id, "review", ["org-"])).toBeUndefined();
    },
  );
});
