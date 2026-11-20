import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppVersionNotice } from "./AppVersionNotice";
import { versionLabels } from "./version-labels";

const runtime = vi.hoisted(() => ({
  apiVersion: "v1",
  uiVersion: "v0.86.163",
  legacyFallback: true,
  scopes: ["admin:read"],
  mode: "authenticated",
  authenticationMode: "session",
  outdated: false,
}));

vi.mock("@/app/auth/AuthProvider", () => ({
  useAuth: () => ({ ...runtime, user: { scopes: runtime.scopes } }),
}));
vi.mock("@/shared/utils/ui-version", () => ({ staleBundle: () => runtime.outdated }));

describe("AppVersionNotice", () => {
  beforeEach(() => {
    Object.assign(runtime, {
      apiVersion: "v1",
      uiVersion: "v0.86.163",
      legacyFallback: true,
      scopes: ["admin:read"],
      mode: "authenticated",
      authenticationMode: "session",
      outdated: false,
    });
  });

  it.each(["v1", "", "확인 불가"])("does not warn for compatible or unavailable API %s", (version) => {
    runtime.apiVersion = version;
    render(<AppVersionNotice />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it.each(["v0", "v2", "v1.1", "<script>private-version</script>"])(
    "warns for unsupported API %s without echoing untrusted metadata",
    (version) => {
      runtime.apiVersion = version;
      render(<AppVersionNotice />);
      const notice = screen.getByRole("status");
      expect(notice).toHaveTextContent(versionLabels.apiMismatchTitle);
      expect(notice).not.toHaveTextContent(version);
      expect(within(notice).getByRole("button", { name: "새로고침" })).toBeEnabled();
      expect(within(notice).getByRole("link", { name: "기존 관리자 열기" })).toHaveAttribute(
        "href",
        "/admin",
      );
    },
  );

  it("removes the warning after a refreshed bootstrap becomes compatible", () => {
    runtime.apiVersion = "v2";
    const view = render(<AppVersionNotice />);
    expect(screen.getByRole("status")).toBeVisible();
    runtime.apiVersion = "v1";
    view.rerender(<AppVersionNotice />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("keeps the warning but removes the legacy link when access is revoked", () => {
    runtime.apiVersion = "v2";
    const view = render(<AppVersionNotice />);
    expect(screen.getByRole("link", { name: "기존 관리자 열기" })).toBeVisible();
    runtime.scopes = ["observability:read"];
    view.rerender(<AppVersionNotice />);
    expect(screen.getByRole("status")).toBeVisible();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    runtime.scopes = ["admin:read"];
    runtime.legacyFallback = false;
    view.rerender(<AppVersionNotice />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("preserves the existing release warning while prioritizing API incompatibility", () => {
    runtime.outdated = true;
    const view = render(<AppVersionNotice />);
    expect(screen.getByRole("status")).toHaveTextContent(versionLabels.staleTitle);
    expect(screen.getByRole("status")).toHaveTextContent(runtime.uiVersion);
    runtime.apiVersion = "v2";
    view.rerender(<AppVersionNotice />);
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent(versionLabels.apiMismatchTitle);
  });

  it("supports keyboard access and exposes an accessible status", async () => {
    runtime.apiVersion = "v2";
    const user = userEvent.setup();
    const view = render(<AppVersionNotice />);
    await user.tab();
    expect(screen.getByRole("button", { name: "새로고침" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("link", { name: "기존 관리자 열기" })).toHaveFocus();
    expect((await axe.run(view.container)).violations).toEqual([]);
  });
});
