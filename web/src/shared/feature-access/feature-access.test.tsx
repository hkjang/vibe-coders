import { act, renderHook } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { beforeEach, describe, expect, it } from "vitest";

import { FeatureAccessContext } from "./context";
import {
  featureMutationReason,
  requestMutationOwners,
  skillMutationOwners,
  type FeatureAccess,
} from "./policy";
import { useFeatureMutationAccess } from "./use-feature-mutation-access";
import { tokenStore } from "@/shared/auth/token-store";

beforeEach(() => tokenStore.clearAll());
describe("화면 소유와 최신 변경 허용 판정", () => {
  it.each([
    undefined,
    { featureId: "wrong", readOnly: false, permitted: true },
    { featureId: "agents.skills", readOnly: false, permitted: false },
    { featureId: "agents.skills", readOnly: true, permitted: true },
  ])("미확인·다른 소유·거부·readonly %j는 닫는다", (access) => {
    expect(featureMutationReason(access, skillMutationOwners)).toBeDefined();
  });
  it("허용 화면이어도 기존 작업 권한을 새로 부여하지 않는다", () => {
    const { result } = renderHook(() => useFeatureMutationAccess(skillMutationOwners, false), {
      wrapper: ({ children }) => (
        <FeatureAccessContext.Provider
          value={{ featureId: "agents.skills", readOnly: false, permitted: true }}
        >
          {children}
        </FeatureAccessContext.Provider>
      ),
    });
    expect(result.current.allowed).toBe(false);
    expect(() => result.current.assertCurrent()).toThrow("필요한 권한");
  });
  it("캡처된 callback도 최신 readonly를 확인하고 복구 뒤 명시 호출만 허용한다", () => {
    let access: FeatureAccess = { featureId: "agents.skills", readOnly: false, permitted: true };
    function Wrapper({ children }: PropsWithChildren) {
      return <FeatureAccessContext.Provider value={access}>{children}</FeatureAccessContext.Provider>;
    }
    const { result, rerender } = renderHook(() => useFeatureMutationAccess(skillMutationOwners, true), {
      wrapper: Wrapper,
    });
    const captured = result.current.assertCurrent;
    expect(captured()).toBeUndefined();
    access = { ...access, readOnly: true };
    rerender();
    expect(result.current.allowed).toBe(false);
    expect(() => captured()).toThrow("읽기 전용");
    access = { ...access, readOnly: false };
    rerender();
    expect(captured()).toBeUndefined();
  });
  it.each(["owner", "session", "unmount"])(
    "이전 callback은 %s가 변경되면 새 허용 상태를 사용하지 못한다",
    (change) => {
      let access: FeatureAccess = { featureId: "observability.llm", readOnly: false, permitted: true };
      function Wrapper({ children }: PropsWithChildren) {
        return <FeatureAccessContext.Provider value={access}>{children}</FeatureAccessContext.Provider>;
      }
      const { result, rerender, unmount } = renderHook(
        () => useFeatureMutationAccess(requestMutationOwners, true),
        { wrapper: Wrapper },
      );
      const captured = result.current.assertCurrent;
      if (change === "owner") {
        access = { ...access, featureId: "observability.xview" };
        rerender();
      }
      if (change === "session") act(() => tokenStore.clearAll());
      if (change === "unmount") unmount();
      expect(() => captured()).toThrow("현재 화면과 인증 세션");
      if (change !== "unmount") expect(result.current.assertCurrent()).toBeUndefined();
    },
  );
  it("context 없는 단독 editor는 기본 허용하지 않는다", () => {
    const { result } = renderHook(() => useFeatureMutationAccess(skillMutationOwners, true));
    expect(result.current.allowed).toBe(false);
    expect(() => result.current.assertCurrent()).toThrow("소유한 화면");
  });
});
