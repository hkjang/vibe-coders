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
    patch({ legacyPath: "/admin#/text2sql?view=public-runtime" });
    render(link());
    const anchor = screen.getByRole("link");
    expect(anchor).toHaveAttribute("href", "/admin#/text2sql?view=public-runtime");
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

describe("FeatureLegacyLink runtime destinations", () => {
  it("follows target metadata updates while a link remains mounted", () => {
    patch({ legacyPath: "/admin#/text2sql?view=public-first" });
    const view = render(link());
    expect(screen.getByRole("link")).toHaveAttribute("href", "/admin#/text2sql?view=public-first");
    patch({ legacyPath: "/admin#/settings/runtime?tab=public-next" });
    view.rerender(link());
    expect(screen.getByRole("link")).toHaveAttribute("href", "/admin#/settings/runtime?tab=public-next");
    runtime.auth.legacyFallback = false;
    view.rerender(link());
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    runtime.auth.legacyFallback = true;
    patch({ legacyPath: "/admin#/text2sql?view=public-final", status: "retired" });
    view.rerender(link());
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    patch({ legacyPath: "/admin#/text2sql?view=public-final", status: "deprecated" });
    view.rerender(link());
    expect(screen.getByRole("link")).toHaveAttribute("href", "/admin#/text2sql?view=public-final");
  });
  it("keeps an explicit IPv6 subroute rather than grafting it onto an unknown default override", () => {
    runtime.auth = testAuth();
    runtime.auth.features = runtime.auth.features.map((entry) =>
      entry.featureId === "access.users"
        ? { ...entry, legacyPath: "/admin#/settings?view=public-accounts" }
        : entry,
    );
    render(
      <FeatureLegacyLink featureId="access.users" href="/admin#/ips/2001%3A0db8%3A%3A1">
        기존 IP
      </FeatureLegacyLink>,
    );
    expect(screen.getByRole("link")).toHaveAttribute("href", "/admin#/ips/2001%3A0db8%3A%3A1");
  });
  it("preserves an explicitly supplied query and hash state byte for byte", () => {
    patch({ legacyPath: "/admin#/settings?view=public-new" });
    render(
      <FeatureLegacyLink
        featureId={feature.featureId}
        href="/admin#/text2sql?schema=public%2Fschema&label=%ED%95%9C%EA%B8%80%20%ED%99%94%EB%A9%B4"
      >
        기존 상세
      </FeatureLegacyLink>,
    );
    expect(screen.getByRole("link")).toHaveAttribute(
      "href",
      "/admin#/text2sql?schema=public%2Fschema&label=%ED%95%9C%EA%B8%80%20%ED%99%94%EB%A9%B4",
    );
  });
  it.each([
    "/admin",
    "/admin/#/text2sql",
    "/admin/settings/new?view=public#section",
    "/admin#/settings?label=%ED%95%9C%EA%B8%80%20%ED%99%94%EB%A9%B4",
  ])("accepts the local admin destination %s without rewriting its bytes", (href) => {
    patch({ legacyPath: href as MigrationFeature["legacyPath"] });
    render(link());
    expect(screen.getByRole("link")).toHaveAttribute("href", href);
  });
  const invalid = [
    "https://example.invalid/admin",
    "//example.invalid/admin",
    "/administrator",
    "/admin/../app",
    "/admin/%2e%2e/app",
    "/admin/%2e%2e%2fapp",
    "/admin\\..\\app",
    "/admin#/settings\n",
    "/admin#/%0asettings",
    "/admin#/settings?token=public",
    "/admin#/settings?value=%76c_sk_abcdefghijk",
    "/admin#/%E0%A4%A",
    "/admin#/" + String.fromCharCode(0xd800),
  ];
  it.each(invalid)("does not expose a malformed runtime destination %s", (href) => {
    patch({ legacyPath: href as MigrationFeature["legacyPath"] });
    render(link());
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(runtime.observe).not.toHaveBeenCalled();
  });
  it.each(invalid)("does not expose a malformed explicit destination %s", (href) => {
    render(
      <FeatureLegacyLink featureId={feature.featureId} href={href}>
        기존 상세
      </FeatureLegacyLink>,
    );
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
  it("rejects configured credential prefixes in runtime and explicit addresses", () => {
    runtime.auth.credentialPrefixes = ["private_test_prefix_"];
    patch({ legacyPath: "/admin#/text2sql?value=private_test_prefix_abcdefghijklmnopqrstuvwxyz012345" });
    const view = render(link());
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    patch({ legacyPath: "/admin#/text2sql" });
    view.rerender(
      <FeatureLegacyLink
        featureId={feature.featureId}
        href="/admin#/text2sql?value=private_test_prefix_abcdefghijklmnopqrstuvwxyz012345"
      >
        기존 상세
      </FeatureLegacyLink>,
    );
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
