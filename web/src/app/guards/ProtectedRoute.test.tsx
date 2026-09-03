import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProtectedRoute } from "@/app/guards/ProtectedRoute";

const authRuntime = vi.hoisted(() => ({
  mode: "authenticated",
  uiEnabled: true,
  legacyFallback: true,
  error: undefined as string | undefined,
}));

vi.mock("@/app/auth/AuthProvider", () => ({ useAuth: () => authRuntime }));

function renderRoute(): ReturnType<typeof render> {
  return render(
    <MemoryRouter>
      <Routes>
        <Route element={<ProtectedRoute />}>
          <Route index element={<h1>Protected content</h1>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("ProtectedRoute runtime UI flags", () => {
  beforeEach(() => {
    authRuntime.mode = "authenticated";
    authRuntime.uiEnabled = true;
    authRuntime.legacyFallback = true;
    authRuntime.error = undefined;
  });

  it("replaces an already loaded SPA with the disabled notice", () => {
    authRuntime.uiEnabled = false;
    authRuntime.legacyFallback = false;
    renderRoute();
    expect(screen.getByRole("heading", { name: "신규 콘솔이 비활성화되어 있습니다." })).toBeVisible();
    expect(screen.getByRole("link", { name: "기존 관리자 화면 열기" })).toHaveAttribute("href", "/admin");
    expect(screen.queryByRole("heading", { name: "Protected content" })).not.toBeInTheDocument();
  });

  it("hides the common error-state Legacy action when fallback is disabled", () => {
    authRuntime.mode = "error";
    authRuntime.legacyFallback = false;
    authRuntime.error = "bootstrap failed";
    renderRoute();
    expect(screen.getByRole("alert")).toHaveTextContent("bootstrap failed");
    expect(screen.queryByRole("link", { name: "Legacy Admin 열기" })).not.toBeInTheDocument();
  });
});
