import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { FeatureRoute } from "@/app/guards/FeatureRoute";
import type { MigrationFeature } from "@/config/migration-registry";

const feature: MigrationFeature = {
  featureId: "routing.rules",
  title: "라우팅 규칙",
  description: "라우팅 규칙을 관리합니다.",
  group: "라우팅",
  keywords: ["라우팅"],
  appPath: "/app/routing/rules",
  legacyPath: "/admin#/routing",
  status: "preview_read_only",
  riskLevel: "high",
  requiredPermission: "routing:read",
  readOnly: true,
  enabledRoles: ["admin"],
  rolloutPercent: 100,
  fallbackEnabled: true,
  minimumApiVersion: "v0.82.0",
};

const authRuntime = vi.hoisted(() => ({
  feature: {} as MigrationFeature,
}));

vi.mock("@/app/auth/AuthProvider", () => ({
  useAuth: () => ({
    backendVersion: "v0.82.1",
    features: [authRuntime.feature],
    legacyFallback: true,
    user: {
      id: "operator-1",
      email: "operator@example.test",
      role: "admin",
      roles: ["admin"],
      team_id: "ops",
      scopes: ["admin:read"],
      features: {},
    },
  }),
}));

describe("FeatureRoute access state", () => {
  beforeEach(() => {
    authRuntime.feature = { ...feature };
  });

  it("shows the required permission instead of the server reason code", () => {
    authRuntime.feature = {
      ...feature,
      serverAvailable: false,
      availabilityReason: "permission_denied",
    };

    render(
      <FeatureRoute feature={feature}>
        <div>보호된 화면</div>
      </FeatureRoute>,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("접근 권한이 없습니다.");
    expect(screen.getByText("필요 권한: routing:read")).toBeVisible();
    expect(screen.queryByText(/permission_denied/)).not.toBeInTheDocument();
    expect(screen.queryByText("보호된 화면")).not.toBeInTheDocument();
  });

  it.each([
    ["role_not_enabled", "현재 역할에는 미리보기가 열려 있지 않습니다."],
    ["outside_rollout", "아직 이 기능의 배포 대상이 아닙니다."],
    ["feature_hidden", "현재 숨김 처리된 기능입니다."],
  ])("maps %s to a Korean access explanation", (reason, expected) => {
    authRuntime.feature = { ...feature, serverAvailable: false, availabilityReason: reason };

    render(<FeatureRoute feature={feature} />);

    expect(screen.getByRole("heading", { name: expected })).toBeVisible();
    expect(screen.queryByText(reason)).not.toBeInTheDocument();
    expect(screen.queryByText(/routing:read/)).not.toBeInTheDocument();
  });
});
