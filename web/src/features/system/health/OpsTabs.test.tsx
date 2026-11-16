import { FeatureAccessHarness } from "@/test/feature-access";
import { testAuth } from "@/test/auth";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SystemHealthPage } from "@/features/system/health/SystemHealthPage";
import { mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";

vi.mock("@/app/auth/AuthProvider", () => ({ useAuth: () => testAuth() }));

import {
  opsHome,
  incidents,
  workers,
  preflight,
  indexHealth,
  migrationSql,
  risk,
} from "./system-health-fixtures";

function mockOpsApi() {
  return mockApi({
    "GET /admin/ops/risk": () => risk,
    "GET /admin/ops/home": () => opsHome,
    "GET /admin/incidents/candidates": () => incidents,
    "GET /admin/ops/workers": () => workers,
    "GET /admin/ops/preflight": () => preflight,
    "GET /admin/index-health": () => indexHealth,
    "GET /admin/migration-sql": () => migrationSql,
  });
}

describe("system health operations tabs", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the operations home cards and the incidents worst first", async () => {
    mockOpsApi();
    renderScreen(
      <FeatureAccessHarness featureId="system.health">
        <SystemHealthPage />
      </FeatureAccessHarness>,
      { path: "/system/health/*", route: "/system/health?tab=ops" },
    );

    expect(await screen.findByText("₩120,000")).toBeVisible();
    // The card links into the new console, not back into the legacy one.
    expect(screen.getByRole("link", { name: /비용/ })).toHaveAttribute("href", "/finops");

    const list = await screen.findByRole("list", { name: "장애 후보" });
    // Only the incidents themselves: each one nests its own list of recommended actions.
    const titles = [...list.querySelectorAll(":scope > li")].map((item) => item.textContent ?? "");
    expect(titles[0]).toContain("공급자 장애");
    expect(titles[1]).toContain("비용 급증");
  });

  it("runs the preflight check only when asked", async () => {
    const api = mockOpsApi();
    const user = userEvent.setup();
    renderScreen(
      <FeatureAccessHarness featureId="system.health">
        <SystemHealthPage />
      </FeatureAccessHarness>,
      { path: "/system/health/*", route: "/system/health?tab=workers" },
    );

    expect(await screen.findByText("async-logger")).toBeVisible();
    expect(api.calls.some((call) => call.key === "GET /admin/ops/preflight")).toBe(false);

    await user.click(screen.getByRole("button", { name: /점검 실행/ }));
    expect(await screen.findByText("데이터베이스 구성")).toBeVisible();
    expect(api.calls.filter((call) => call.key === "GET /admin/ops/preflight")).toHaveLength(1);
  });

  it("shows index drift and opens the migration SQL only on request", async () => {
    const api = mockOpsApi();
    const user = userEvent.setup();
    renderScreen(
      <FeatureAccessHarness featureId="system.health">
        <SystemHealthPage />
      </FeatureAccessHarness>,
      { path: "/system/health/*", route: "/system/health?tab=indexes" },
    );

    expect(await screen.findByText("idx_requests_created")).toBeVisible();
    expect(screen.getByText("DROP INDEX idx_requests_created;")).toBeVisible();
    expect(api.calls.some((call) => call.key === "GET /admin/migration-sql")).toBe(false);

    await user.click(screen.getByRole("button", { name: /마이그레이션 SQL 보기/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("CREATE TABLE requests (id TEXT PRIMARY KEY);")).toBeVisible();

    // "이 DB와 다른 인덱스만" keeps the mismatched index and drops the plain table statement.
    await user.click(within(dialog).getByLabelText("이 DB와 다른 인덱스만"));
    expect(
      within(dialog).queryByText("CREATE TABLE requests (id TEXT PRIMARY KEY);"),
    ).not.toBeInTheDocument();
    expect(
      within(dialog).getByText("CREATE INDEX idx_requests_created ON requests(created_at);"),
    ).toBeVisible();
  });

  it("has no automated accessibility violations on the operations home", async () => {
    mockOpsApi();
    const { container } = renderScreen(
      <FeatureAccessHarness featureId="system.health">
        <SystemHealthPage />
      </FeatureAccessHarness>,
      {
        path: "/system/health/*",
        route: "/system/health?tab=ops",
      },
    );

    await screen.findByRole("list", { name: "장애 후보" });
    expect((await axe.run(container)).violations).toEqual([]);
  });
});
