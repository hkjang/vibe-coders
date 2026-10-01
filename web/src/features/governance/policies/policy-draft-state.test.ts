import { describe, expect, it } from "vitest";
import { policyDraftAcknowledged, policyDraftSnapshot } from "./policy-draft-state";

describe("초안 원래 본문과 제한된 성공 확인", () => {
  for (const title of ["", "\u0085", "\ufeff", "  공개 제목  "]) {
    it(`title ${JSON.stringify(title)}를 서버 정규화 전에 바꾸지 않는다`, () => {
      expect(
        policyDraftSnapshot({ id: "public-id", title, conditions: null, actions: { custom: true } }, "7d")
          .body,
      ).toEqual({ title, conditions: {}, actions: { custom: true } });
    });
  }
  it("누락 제목만 기존 ID를 사용하고 ID/기간을 body에 추가하지 않는다", () => {
    expect(policyDraftSnapshot({ id: "public-id" }, "24h").body).toEqual({
      title: "public-id",
      conditions: {},
      actions: {},
    });
  });
  for (const value of [
    undefined,
    null,
    {},
    { policy_id: "a" },
    { policy_id: "", enabled: false },
    { policy_id: "a", enabled: true },
  ]) {
    it(`불완전 응답 ${JSON.stringify(value)}은 성공을 확정하지 않는다`, () =>
      expect(policyDraftAcknowledged(value)).toBe(false));
  }
  it("flat policy_id와 enabled:false만으로 비활성 생성 확인을 제한한다", () => {
    expect(
      policyDraftAcknowledged({ policy_id: "pol_public", enabled: false, note: "unknown unrendered" }),
    ).toBe(true);
  });
});
