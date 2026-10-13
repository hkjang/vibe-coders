import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ApiKeysTab } from "./ApiKeysTab";
import { apiKeyPublicSchema } from "@/shared/api/domains/access.schemas";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth() };
});
afterEach(() => vi.restoreAllMocks());

it("관리자 목록·요약·필터가 만료와 교체 유예를 같은 시각 기준으로 표시한다", async () => {
  const now = Date.now();
  const expired = apiKeyPublicSchema.parse({
    id: "expired",
    name: "이미 만료",
    role: "developer",
    status: "active",
    expires_at: new Date(now - 1000).toISOString(),
  });
  const grace = apiKeyPublicSchema.parse({
    id: "grace",
    name: "교체된 키",
    status: "active",
    replaced_by: "next",
    grace_ends_at: new Date(now + 60000).toISOString(),
  });
  mockApi({ "GET /admin/api-keys": () => ({ api_keys: [expired, grace], revoke_review_supported: true }) });
  renderScreen(
    <FeatureAccessContext.Provider value={{ featureId: "access.users", permitted: true, readOnly: false }}>
      <ApiKeysTab canWrite={false} isSuperAdmin={false} writeDeniedReason="조회 전용" />
    </FeatureAccessContext.Provider>,
  );
  const expiredRow = await screen.findByRole("row", { name: /이미 만료/ });
  expect(within(expiredRow).getByText("만료", { exact: true })).toBeVisible();
  expect(within(expiredRow).getByText("개발자", { exact: true })).toBeVisible();
  expect(
    within(await screen.findByRole("row", { name: /교체된 키/ })).getByText("교체 유예 중"),
  ).toBeVisible();
  const summary = screen.getByRole("region", { name: "API 키 요약" });
  const count = (label: string) =>
    within(summary).getByText(label, { exact: true }).closest("article")?.querySelector("strong")
      ?.textContent;
  expect(count("사용 가능")).toBe("1");
  expect(count("만료·유예 종료")).toBe("1");
  vi.spyOn(Date, "now").mockReturnValue(now + 61000);
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(
    within(screen.getByRole("row", { name: /교체된 키/ })).getByText("유예 종료", { exact: true }),
  ).toBeVisible();
  expect(count("사용 가능")).toBe("0");
  expect(count("만료·유예 종료")).toBe("2");
  fireEvent.change(screen.getByLabelText("상태", { exact: true }), { target: { value: "expired" } });
  expect(screen.getByRole("row", { name: /이미 만료/ })).toBeVisible();
  expect(screen.queryByRole("row", { name: /교체된 키/ })).not.toBeInTheDocument();
});
