import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LoginPage } from "@/app/auth/LoginPage";

const authRuntime = vi.hoisted(() => ({ legacyFallback: true }));

vi.mock("@/app/auth/AuthProvider", () => ({
  useAuth: () => ({
    mode: "anonymous",
    authenticationMode: "legacy_token",
    legacyFallback: authRuntime.legacyFallback,
    backendVersion: "v0.80.0",
    uiVersion: "v0.80.0",
    apiVersion: "v1",
    sso: { allow_local_login: true, keycloak_enabled: false, login_url: "/auth/keycloak/login" },
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
    authRuntime.legacyFallback = true;
  });

  it("shows the Legacy Admin link in Legacy token mode when fallback is enabled", () => {
    renderLogin();
    expect(screen.getByRole("link", { name: "기존 관리자 화면" })).toHaveAttribute("href", "/admin");
  });

  it("hides the Legacy Admin link when runtime fallback is disabled", () => {
    authRuntime.legacyFallback = false;
    renderLogin();
    expect(screen.queryByRole("link", { name: "기존 관리자 화면" })).not.toBeInTheDocument();
  });
});
