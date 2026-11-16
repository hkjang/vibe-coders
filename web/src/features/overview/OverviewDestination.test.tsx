import { screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { testAuth } from "@/test/auth";
import { renderScreen } from "@/test/render";
import { OverviewDestination } from "./OverviewDestination";

const state = vi.hoisted(() => ({ auth: {} as ReturnType<typeof testAuth> }));
vi.mock("@/app/auth/AuthProvider", () => ({ useAuth: () => state.auth }));
beforeEach(() => {
  state.auth = testAuth({ backendVersion: "v0.86.104" });
});
it("선택한 라우팅 기간과 임계값을 같은 상태 화면으로 전달한다", () => {
  renderScreen(<OverviewDestination featureId="routing.rules" label="라우팅 상태 열기" range="7d" />);
  expect(screen.getByRole("link", { name: "라우팅 상태 열기" })).toHaveAttribute(
    "href",
    "/routing/rules/health?window=7d&threshold=70",
  );
});
it.each(["scope", "hidden", "rollout", "fallback"])(
  "%s 제한은 현재 권한·전환 정책에 맞게 연결한다",
  (reason) => {
    if (reason === "scope") state.auth = testAuth({ scopes: [] });
    state.auth = {
      ...state.auth,
      legacyFallback: reason !== "fallback",
      features: state.auth.features.map((feature) =>
        feature.featureId === "routing.rules"
          ? {
              ...feature,
              serverAvailable: undefined,
              status: reason === "hidden" ? "hidden" : reason === "fallback" ? "legacy" : "preview",
              rolloutPercent: reason === "rollout" ? 0 : 100,
            }
          : feature,
      ),
    };
    renderScreen(<OverviewDestination featureId="routing.rules" label="라우팅 상태 열기" />);
    if (reason === "rollout") {
      expect(screen.getByRole("link")).toHaveAttribute("href", "/admin#/routing");
      expect(screen.getByText("기존 화면")).toBeVisible();
    } else expect(screen.queryByRole("link")).not.toBeInTheDocument();
  },
);
it("기존 화면 단계는 등록된 기존 주소로 이동하고 임의의 필터를 덧붙이지 않는다", () => {
  state.auth = {
    ...state.auth,
    features: state.auth.features.map((feature) =>
      feature.featureId === "routing.rules" ? { ...feature, status: "legacy" } : feature,
    ),
  };
  renderScreen(<OverviewDestination featureId="routing.rules" label="라우팅 상태 열기" range="7d" />);
  expect(screen.getByRole("link", { name: /라우팅 상태 열기/ })).toHaveAttribute("href", "/admin#/routing");
  expect(screen.getByText("기존 화면")).toBeVisible();
});
