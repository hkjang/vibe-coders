import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { OverviewPage } from "@/features/overview/OverviewPage";
import { apiClient } from "@/shared/api/client";
import { usePreferences } from "@/shared/stores/preferences";

const authRuntime = vi.hoisted(() => ({ legacyFallback: true }));

vi.mock("@/app/auth/AuthProvider", () => ({
  useAuth: () => ({
    backendVersion: "v0.80.0",
    legacyFallback: authRuntime.legacyFallback,
    mode: "authenticated",
    user: { scopes: ["admin:read"] },
  }),
}));

function renderOverview(): ReturnType<typeof render> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <OverviewPage />
    </QueryClientProvider>,
  );
}

describe("OverviewPage Legacy bridge", () => {
  beforeEach(() => {
    authRuntime.legacyFallback = true;
    usePreferences.setState({ refreshInterval: 0 });
    vi.spyOn(apiClient, "request").mockResolvedValue({ status: "ok" });
  });

  it("shows the four domain Legacy links when fallback is enabled", () => {
    renderOverview();
    expect(screen.getAllByRole("link")).toHaveLength(4);
  });

  it("replaces every domain Legacy link when fallback is disabled", () => {
    authRuntime.legacyFallback = false;
    renderOverview();
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(screen.getAllByText("Legacy 이동이 비활성화되어 있습니다.")).toHaveLength(4);
  });
});
