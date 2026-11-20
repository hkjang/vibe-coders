import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { SystemSettingsPage } from "./SystemSettingsPage";
import { mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";
import { FeatureAccessHarness } from "@/test/feature-access";
import type { EffectiveSetting } from "@/shared/api/domains/system.schemas";

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ scopes: ["admin:read", "admin:write"] }) };
});

const settings: EffectiveSetting[] = [
  ["env.auth_enabled", "bool", "true"],
  ["env.auth_access_token_ttl", "duration", "15m0s"],
  ["env.auth_refresh_token_ttl", "duration", "168h0m0s"],
  ["env.auth_jwt_configured", "bool", "false"],
  ["env.self_service_keys_enabled", "bool", "false"],
].map(([key = "", type = "", value = ""]) => ({
  key,
  type,
  value,
  category: "env.auth",
  description: "시작할 때 읽은 환경변수 값",
  source: "env",
  effective_source: "bootstrap_env",
  read_only: true,
  restart_required: true,
  is_secret: false,
  is_set: true,
  can_write: false,
}));

it("인증 시작 설정을 한글로 찾고 상세·주소 복원에서도 변경을 막는다", async () => {
  const write = vi.fn();
  mockApi({
    "GET /admin/settings/effective": () => ({ settings }),
    "GET /admin/settings/history": () => ({ history: [] }),
    "PUT /admin/settings/by-key/env.auth_access_token_ttl": write,
  });
  const user = userEvent.setup();
  renderScreen(
    <FeatureAccessHarness featureId="system.settings">
      <SystemSettingsPage />
    </FeatureAccessHarness>,
    { route: "/system/settings?tab=runtime&category=env.auth&q=접근 토큰", path: "/system/settings" },
  );
  const link = await screen.findByRole("link", { name: "접근 토큰 유효기간" });
  expect(screen.getByRole("combobox", { name: "범주" })).toHaveDisplayValue("인증 · 시작 환경");
  expect(screen.getByText("인증 시작 설정")).toBeVisible();
  expect(screen.queryByRole("link", { name: "계정 인증 사용" })).not.toBeInTheDocument();
  await user.click(link);
  const sheet = await screen.findByRole("dialog", { name: "접근 토큰 유효기간" });
  expect(within(sheet).getByText("env.auth_access_token_ttl")).toBeVisible();
  expect(within(sheet).getByRole("region", { name: "설정 상세 내용" })).toHaveAttribute("tabindex", "0");
  expect(within(sheet).getByRole("button", { name: "저장" })).toBeDisabled();
  expect(within(sheet).getByRole("button", { name: "기본값(환경변수)으로 되돌리기" })).toBeDisabled();
  expect(within(sheet).getByText("15m0s")).toBeVisible();
  await user.keyboard("{Escape}");
  expect(write).not.toHaveBeenCalled();
});

it("서명 키의 설정 여부만 표시하고 비밀값으로 잘못 표시된 응답도 숨긴다", async () => {
  mockApi({
    "GET /admin/settings/effective": () => ({
      settings: [
        ...settings,
        {
          ...settings[0],
          key: "env.auth_jwt_configured",
          is_secret: true,
          value: "public-secret-canary",
          is_set: true,
        },
      ].filter((_row, index) => index !== 3),
    }),
  });
  renderScreen(
    <FeatureAccessHarness featureId="system.settings">
      <SystemSettingsPage />
    </FeatureAccessHarness>,
    { route: "/system/settings?category=env.auth", path: "/system/settings" },
  );
  expect(await screen.findByRole("link", { name: "JWT 서명 키 설정 여부" })).toBeVisible();
  expect(screen.queryByText("public-secret-canary")).not.toBeInTheDocument();
  expect(screen.getByText("설정됨 (표시하지 않음)")).toBeVisible();
  expect(screen.getByText("사용함")).toBeVisible();
});
