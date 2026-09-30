import { renderHook } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import type { FeatureAccess } from "@/shared/feature-access/policy";
import { AppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";
import { useRoutingToggleAccess } from "./routing-toggle-access";
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ scopes: ["routing:read", "routing:write"] }) };
});
beforeEach(() => tokenStore.clearAll());

const owner: FeatureAccess = { featureId: "routing.rules", permitted: true, readOnly: false };
describe("토글 로컬 접근 checker의 명시적 문맥 경계", () => {
  for (const [name, invalid] of [
    ["누락", undefined],
    ["다른 owner", { ...owner, featureId: "gateway.health" }],
    ["접근 거부", { ...owner, permitted: false }],
    ["불명확 permitted", { ...owner, permitted: "true" }],
    ["불명확 readonly", { ...owner, readOnly: undefined }],
  ] as const) {
    it(`${name}: 현재 읽기·변경 및 이전 캡처 checker 모두 거부`, () => {
      let context: FeatureAccess | undefined = owner;
      function Wrapper({ children }: PropsWithChildren) {
        return <FeatureAccessContext.Provider value={context}>{children}</FeatureAccessContext.Provider>;
      }
      const hook = renderHook(() => useRoutingToggleAccess(true), { wrapper: Wrapper });
      const before = hook.result.current;
      expect(before.readAllowed).toBe(true);
      expect(before.write.allowed).toBe(true);
      context = invalid as unknown as FeatureAccess | undefined;
      hook.rerender();
      expect(hook.result.current.readAllowed).toBe(false);
      expect(hook.result.current.write.allowed).toBe(false);
      expect(before.assertRead).toThrow(AppError);
      expect(before.write.assertCurrent).toThrow(AppError);
    });
  }
  it("readonly는 규칙 조회를 허용하지만 변경 checker는 거부", () => {
    function Wrapper({ children }: PropsWithChildren) {
      return (
        <FeatureAccessContext.Provider value={{ ...owner, readOnly: true }}>
          {children}
        </FeatureAccessContext.Provider>
      );
    }
    const hook = renderHook(() => useRoutingToggleAccess(true), { wrapper: Wrapper });
    expect(hook.result.current.readAllowed).toBe(true);
    expect(hook.result.current.assertRead).not.toThrow();
    expect(hook.result.current.write.allowed).toBe(false);
    expect(hook.result.current.write.assertCurrent).toThrow(AppError);
  });
});
