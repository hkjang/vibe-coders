import { expect, it } from "vitest";
import type { AdminKeyRevokeRequest, DeleteAdminApiKeysIdData } from "@/shared/api/generated";

it("관리자 폐기 계약은 기존 빈 본문과 전체 검토만 허용하고 완전 삭제 인자를 제공한다", () => {
  const empty: AdminKeyRevokeRequest = {};
  const legacyNull: AdminKeyRevokeRequest = null;
  const reviewed: AdminKeyRevokeRequest = { reason: "사용 종료", expected_revision: "a".repeat(64) };
  const deletion: DeleteAdminApiKeysIdData = {
    path: { id: "public-test-key" },
    url: "/admin/api-keys/{id}",
    body: reviewed,
    query: { hard: 1 },
  };
  // @ts-expect-error A reason alone is not a valid reviewed request.
  const reasonOnly: AdminKeyRevokeRequest = { reason: "사용 종료" };
  // @ts-expect-error A revision alone is not a valid reviewed request.
  const revisionOnly: AdminKeyRevokeRequest = { expected_revision: "a".repeat(64) };
  // @ts-expect-error Legacy empty objects must not permit arbitrary fields.
  const unknownField: AdminKeyRevokeRequest = { extra: true };
  expect([empty, legacyNull, reviewed, reasonOnly, revisionOnly, unknownField]).toHaveLength(6);
  expect(deletion.query?.hard).toBe(1);
});
