import { describe, expect, it } from "vitest";
import { domainDecisionRequestIDError, normalizeDomainDecisionRequestID } from "./domain-decision-filters";

describe("도메인 결정 요청 ID의 조회·주소 경계", () => {
  it("서버와 같이 NEL은 제거하고 FEFF는 보존한다", () => {
    expect(normalizeDomainDecisionRequestID(" \u0085한글\u0085 ")).toBe("한글");
    expect(normalizeDomainDecisionRequestID("\ufeff공개\ufeff")).toBe("\ufeff공개\ufeff");
    expect(domainDecisionRequestIDError("\ufeff공개\ufeff")).toBeUndefined();
  });
  it.each(["", "한글 / %2f ?#", "__proto__", "request_😀", "a".repeat(512)])(
    "지원 ID %s를 정확히 보존한다",
    (value) => {
      expect(normalizeDomainDecisionRequestID(value)).toBe(value);
      expect(domainDecisionRequestIDError(value)).toBeUndefined();
    },
  );
  it.each([
    " 앞",
    "뒤 ",
    "\u0085앞",
    "한\n글",
    "한\u0000글",
    "한\u007f글",
    "\ud800",
    "\udc00",
    "a".repeat(513),
    "한".repeat(171),
  ])("안전하게 복원할 수 없는 ID를 거부한다 %#", (value) => {
    expect(domainDecisionRequestIDError(value)).toBeDefined();
  });
});
