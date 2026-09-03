import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LoginPage } from "@/app/auth/LoginPage";

const authRuntime = vi.hoisted(() => ({
  authenticationMode: "legacy_token" as "legacy_token" | "session",
  error: undefined as string | undefined,
  legacyFallback: true,
  sso: { allow_local_login: true, keycloak_enabled: false, login_url: "/auth/keycloak/login" },
}));

vi.mock("@/app/auth/AuthProvider", () => ({
  useAuth: () => ({
    mode: "anonymous",
    authenticationMode: authRuntime.authenticationMode,
    legacyFallback: authRuntime.legacyFallback,
    backendVersion: "v0.80.0",
    uiVersion: "v0.80.0",
    apiVersion: "v1",
    error: authRuntime.error,
    sso: authRuntime.sso,
    login: vi.fn(),
    setLegacyToken: vi.fn(),
  }),
}));

function renderLogin(): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={["/login"]}>
      <Routes>
        <Route path="login" element={<LoginPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("LoginPage Legacy bridge", () => {
  beforeEach(() => {
    authRuntime.authenticationMode = "legacy_token";
    authRuntime.error = undefined;
    authRuntime.legacyFallback = true;
    authRuntime.sso = {
      allow_local_login: true,
      keycloak_enabled: false,
      login_url: "/auth/keycloak/login",
    };
  });

  it("shows the Legacy Admin link in Legacy token mode when fallback is enabled", () => {
    renderLogin();
    expect(screen.getByRole("link", { name: "기존 관리자 화면" })).toHaveAttribute("href", "/admin");
    expect(
      screen.getByText("브라우저 탭의 세션 저장소에만 저장하며 로컬 저장소에는 저장하지 않습니다."),
    ).toBeVisible();
  });

  it("hides the Legacy Admin link when runtime fallback is disabled", () => {
    authRuntime.legacyFallback = false;
    renderLogin();
    expect(screen.queryByRole("link", { name: "기존 관리자 화면" })).not.toBeInTheDocument();
  });

  it("shows an SSO provisioning error when local login is disabled", () => {
    authRuntime.authenticationMode = "session";
    authRuntime.error =
      "SSO 사용자 정보를 준비하지 못했습니다. 잠시 후 다시 시도하거나 관리자에게 문의하세요. (진단 코드: user_provisioning_failed)";
    authRuntime.sso = {
      allow_local_login: false,
      keycloak_enabled: true,
      login_url: "/auth/keycloak/login",
    };

    renderLogin();

    expect(screen.getByRole("alert")).toHaveTextContent("SSO 사용자 정보를 준비하지 못했습니다.");
    expect(screen.getByRole("button", { name: /Keycloak SSO/ })).toBeVisible();
    expect(screen.queryByLabelText("이메일")).not.toBeInTheDocument();
  });
});
