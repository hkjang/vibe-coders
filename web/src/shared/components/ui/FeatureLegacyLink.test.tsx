import { createEvent, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { migrationRegistry, type MigrationFeature } from "@/config/migration-registry";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { testAuth } from "@/test/auth";
import { FeatureLegacyLink } from "./FeatureLegacyLink";

const runtime = vi.hoisted(() => ({ auth: {} as ReturnType<typeof testAuth>, observe: vi.fn() }));
vi.mock("@/app/auth/AuthProvider", () => ({ useAuth: () => runtime.auth }));
vi.mock("@/shared/telemetry/legacy-observation", () => ({ useObserveLegacyOpen: () => runtime.observe }));
const feature = (() => {
  const entry = migrationRegistry.find((item) => item.featureId === "text2sql.overview");
  if (!entry) throw new Error("Missing Text2SQL feature fixture");
  return entry;
})();
function patch(value: Partial<MigrationFeature>) {
  runtime.auth.features = [{ ...feature, ...value }];
}
const link = () => (
  <FeatureLegacyLink featureId={feature.featureId} href="/admin#/text2sql">
    기존 화면
  </FeatureLegacyLink>
);
beforeEach(() => {
  runtime.auth = testAuth();
  runtime.observe.mockReset();
  patch({ status: "preview", serverAvailable: true });
});

describe("FeatureLegacyLink target policy", () => {
  it.each(["legacy", "preview_read_only", "preview", "stable", "deprecated"] as const)(
    "preserves configured %s fallback",
    (status) => {
      patch({ status });
      render(link());
      expect(screen.getByRole("link")).toHaveAttribute("href", "/admin#/text2sql");
    },
  );
  it.each(["hidden", "retired"] as const)("never promotes %s, even with an older API", (status) => {
    patch({ status, serverAvailable: true });
    runtime.auth.backendVersion = "v0.1.0";
    render(link());
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(runtime.observe).not.toHaveBeenCalled();
  });
  it.each([
    "global",
    "feature",
    "unavailable",
    "unknown",
    "admin_scope",
    "feature_scope",
    "loading",
    "anonymous",
    "error",
  ] as const)("fails closed for %s", (condition) => {
    if (condition === "global") runtime.auth.legacyFallback = false;
    if (condition === "feature") patch({ fallbackEnabled: false });
    if (condition === "unavailable") patch({ serverAvailable: false });
    if (condition === "unknown") runtime.auth.features = [];
    if (condition === "admin_scope") runtime.auth = testAuth({ scopes: ["routing:read"] });
    if (condition === "feature_scope") patch({ requiredPermission: "missing:read", serverAvailable: true });
    if (condition === "loading" || condition === "anonymous" || condition === "error")
      runtime.auth.mode = condition;
    render(link());
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
  it("uses the explicit target instead of the retired route containing the link", () => {
    render(
      <FeatureAccessContext.Provider
        value={{ featureId: "overview", status: "retired", readOnly: true, permitted: true }}
      >
        {link()}
      </FeatureAccessContext.Provider>,
    );
    expect(screen.getByRole("link")).toBeVisible();
  });
  it("removes a mounted target when its fallback or permission is revoked", () => {
    const result = render(link());
    expect(screen.getByRole("link")).toBeVisible();
    patch({ fallbackEnabled: false });
    result.rerender(link());
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    patch({ status: "deprecated", serverAvailable: true });
    result.rerender(link());
    expect(screen.getByRole("link")).toBeVisible();
    patch({ serverAvailable: false, availabilityReason: "permission_denied" });
    result.rerender(link());
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
  it("keeps native keyboard and middle-click defaults while observing each allowed activation", () => {
    render(link());
    const anchor = screen.getByRole("link");
    anchor.focus();
    expect(anchor).toHaveFocus();
    const keyboardClick = createEvent.click(anchor, { button: 0, detail: 0, cancelable: true });
    fireEvent(anchor, keyboardClick);
    expect(keyboardClick.defaultPrevented).toBe(false);
    const middleClick = new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true });
    fireEvent(anchor, middleClick);
    expect(middleClick.defaultPrevented).toBe(false);
    expect(runtime.observe).toHaveBeenCalledTimes(2);
  });
  it("honors caller cancellation without recording navigation", () => {
    render(
      <FeatureLegacyLink
        featureId={feature.featureId}
        href="/admin#/text2sql"
        onClick={(event) => event.preventDefault()}
      >
        기존 화면
      </FeatureLegacyLink>,
    );
    const event = createEvent.click(screen.getByRole("link"), { button: 0, cancelable: true });
    fireEvent(screen.getByRole("link"), event);
    expect(event.defaultPrevented).toBe(true);
    expect(runtime.observe).not.toHaveBeenCalled();
  });
  it("retains authorized fallback when preview rollout or minimum API is unavailable", () => {
    patch({ serverAvailable: undefined, rolloutPercent: 0 });
    const result = render(link());
    expect(screen.getByRole("link")).toBeVisible();
    runtime.auth.backendVersion = "v0.1.0";
    result.rerender(link());
    expect(screen.getByRole("link")).toBeVisible();
  });
});
