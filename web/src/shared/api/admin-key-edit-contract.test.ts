import { expect, it } from "vitest";
import type { AdminKeyUpdateRequest } from "@/shared/api/generated";

it("키 수정 계약은 기존 필드와 필수 검토 정보 쌍을 구분한다", () => {
  const legacy: AdminKeyUpdateRequest = { name: "새 이름", scopes: null };
  const reviewed: AdminKeyUpdateRequest = {
    name: "새 이름",
    review: { reason: "업무 이름 정리", expected_revision: "a".repeat(64) },
  };
  // @ts-expect-error A review without its revision must not compile.
  const reasonOnly: AdminKeyUpdateRequest = { review: { reason: "확인" } };
  // @ts-expect-error A review without its reason must not compile.
  const revisionOnly: AdminKeyUpdateRequest = { review: { expected_revision: "a".repeat(64) } };
  // @ts-expect-error Explicit null review is not the legacy omitted review.
  const nullReview: AdminKeyUpdateRequest = { review: null };
  expect([legacy, reviewed, reasonOnly, revisionOnly, nullReview]).toHaveLength(5);
});
