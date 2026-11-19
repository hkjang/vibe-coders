import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testAuth } from "@/test/auth";
import type { MigrationFeature } from "@/config/migration-registry";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { RemediationLegacyLink } from "@/features/governance/remediation/RemediationLegacyLink";
import { LegacyFeaturePage } from "@/features/legacy/LegacyFeaturePage";
import { CostGuardContractNotice } from "@/shared/components/form/CostGuardContractNotice";
import { ErrorState } from "@/shared/components/state/PageStates";
import { FeatureLegacyLink } from "./FeatureLegacyLink";

const runtime = vi.hoisted(() => ({ auth: {} as ReturnType<typeof testAuth> }));
vi.mock("@/app/auth/AuthProvider", () => ({ useAuth: () => runtime.auth }));
beforeEach(() => {
  runtime.auth = testAuth();
});
function patch(featureId: string, value: Partial<MigrationFeature>) {
  runtime.auth.features = runtime.auth.features.map((feature) =>
    feature.featureId === featureId ? { ...feature, ...value } : feature,
  );
}

describe("Legacy destinations across feature boundaries", () => {
  it.each([
    ["#/billing", "finops.overview", "/admin#/billing"],
    ["#/safety", "governance.policies", "/admin#/safety"],
  ])("checks the actual %s target independently of a retired remediation owner", (link, target, href) => {
    const tree = (
      <FeatureAccessContext.Provider
        value={{ featureId: "governance.remediation", permitted: true, readOnly: false, status: "retired" }}
      >
        <RemediationLegacyLink link={link} />
      </FeatureAccessContext.Provider>
    );
    const view = render(tree);
    expect(screen.getByRole("link")).toHaveAttribute("href", href);
    patch(target, { status: "retired" });
    view.rerender(<RemediationLegacyLink link={link} />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    patch(target, { status: "deprecated" });
    view.rerender(<RemediationLegacyLink link={link} />);
    expect(screen.getByRole("link")).toBeVisible();
    patch(target, { fallbackEnabled: false });
    view.rerender(<RemediationLegacyLink link={link} />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
  it.each(["#/billing", "#/safety"])("does not borrow admin scope for %s target permissions", (link) => {
    runtime.auth = testAuth({ scopes: ["admin:read", "admin:write"] });
    render(<RemediationLegacyLink link={link} />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
  it.each([
    undefined,
    "",
    "#/settings",
    "#/billing?secret=public",
    "/admin#/billing",
    "https://example.invalid",
    "__proto__",
    "#/safety/unknown",
  ])("does not invent a destination for %s", (link) => {
    render(<RemediationLegacyLink link={link} />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
  it("keeps exact supported error href state and removes it when the target is disabled", () => {
    const renderError = () => (
      <ErrorState
        message="조회 실패"
        legacyFeatureId="observability.traces"
        legacyHref="/admin#/llm?trace=public%2Ftrace"
      />
    );
    const view = render(renderError());
    expect(screen.getByRole("link")).toHaveAttribute("href", "/admin#/llm?trace=public%2Ftrace");
    patch("observability.traces", { fallbackEnabled: false });
    view.rerender(renderError());
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
  it("does not replace a missing feature destination with admin home", () => {
    render(<ErrorState message="조회 실패" legacyFeatureId="observability.traces" />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
  it("retains explicit global home recovery outside the feature policy", () => {
    render(
      <FeatureAccessContext.Provider
        value={{ featureId: "observability.traces", status: "retired", permitted: true, readOnly: true }}
      >
        <ErrorState message="전역 복구" />
      </FeatureAccessContext.Provider>,
    );
    expect(screen.getByRole("link")).toHaveAttribute("href", "/admin");
  });
  it("uses policy permissions for the cost-guard notice even inside the routing feature", () => {
    runtime.auth.backendVersion = "v0.1.0";
    const view = render(
      <FeatureAccessContext.Provider value={{ featureId: "routing.rules", permitted: true, readOnly: false }}>
        <CostGuardContractNotice />
      </FeatureAccessContext.Provider>,
    );
    expect(screen.getByRole("link")).toHaveAttribute("href", "/admin#/safety");
    patch("governance.policies", { status: "retired" });
    view.rerender(<CostGuardContractNotice />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
  it("explains a bridge whose user cannot access Legacy admin", () => {
    runtime.auth = testAuth({ scopes: ["routing:read"] });
    const feature = runtime.auth.features.find((entry) => entry.featureId === "routing.rules");
    if (!feature) throw new Error("Missing routing fixture");
    render(<LegacyFeaturePage feature={feature} />);
    expect(screen.getByText(/기존 화면을 열 수 없습니다/)).toBeVisible();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
  it.each(["features", "backendVersion"])("fails safely when %s metadata is unavailable", (field) => {
    Reflect.deleteProperty(runtime.auth, field);
    render(
      <FeatureLegacyLink featureId="overview" href="/admin#/dashboard">
        기존 화면
      </FeatureLegacyLink>,
    );
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
