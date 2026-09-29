import { createEvent, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, type MouseEventHandler } from "react";
import { Link, MemoryRouter, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthContextValue } from "@/app/auth/AuthProvider";
import { featureByPath, migrationRegistry, type MigrationFeature } from "@/config/migration-registry";
import { apiClient } from "@/shared/api/client";
import { AppError } from "@/shared/api/error";
import { LegacyLink } from "@/shared/components/ui/LegacyLink";
import { FeatureTelemetry } from "@/shared/telemetry/FeatureTelemetry";
import type { MockedRequestOptions } from "@/test/api";
import { testAuth } from "@/test/auth";

const authState = vi.hoisted(() => ({ current: {} as AuthContextValue }));
vi.mock("@/app/auth/AuthProvider", () => ({ useAuth: () => authState.current }));

interface VisitEvent {
  feature_id: string;
  visit_id: string;
  event: "visit" | "legacy_fallback";
}

const feature = migrationRegistry.find((item) => item.featureId === "system.settings");
if (!feature) throw new Error("Missing system.settings feature fixture");
const settingsFeature: MigrationFeature = { ...feature };

function observeRequests() {
  const request = vi.spyOn(apiClient, "request").mockResolvedValue(undefined as never);
  return {
    request,
    events: () =>
      request.mock.calls.map(([, options]) => (options as MockedRequestOptions)?.body as VisitEvent),
  };
}

function RouteHarness(): React.JSX.Element {
  const location = useLocation();
  return (
    <FeatureTelemetry feature={featureByPath(location.pathname)}>
      <p>private-user private-team private-prompt</p>
      <Link to="/system/settings?prompt=private-prompt&team=private-team">필터 변경</Link>
      <Link to="/overview">다른 기능</Link>
      <Link to="/system/settings">다시 진입</Link>
      <LegacyLink href="#legacy">기존 화면</LegacyLink>
    </FeatureTelemetry>
  );
}

beforeEach(() => {
  authState.current = testAuth({ telemetryEnabled: true });
});

describe("FeatureTelemetry eligibility and visit lifecycle", () => {
  it.each([
    "default",
    "disabled",
    "ui_disabled",
    "loading",
    "anonymous",
    "error",
    "permission",
    "unavailable",
  ])("does not observe when eligibility is %s", (condition) => {
    const api = observeRequests();
    let currentFeature = settingsFeature;
    if (condition === "default") authState.current = testAuth();
    if (condition === "disabled") authState.current.telemetryEnabled = false;
    if (condition === "ui_disabled") authState.current.uiEnabled = false;
    if (condition === "loading" || condition === "anonymous" || condition === "error") {
      authState.current.mode = condition;
    }
    if (condition === "permission") authState.current = testAuth({ telemetryEnabled: true, scopes: [] });
    if (condition === "unavailable") currentFeature = { ...settingsFeature, serverAvailable: false };
    render(
      <FeatureTelemetry feature={currentFeature}>
        <LegacyLink href="#legacy">기존 화면</LegacyLink>
      </FeatureTelemetry>,
    );
    fireEvent.click(screen.getByRole("link"));
    expect(api.request).not.toHaveBeenCalled();
  });

  it("deduplicates StrictMode effects, rerenders and filter changes but starts a new visit on actual feature reentry", async () => {
    const api = observeRequests();
    const user = userEvent.setup();
    const tree = (
      <StrictMode>
        <MemoryRouter initialEntries={["/system/settings?tab=console"]}>
          <RouteHarness />
        </MemoryRouter>
      </StrictMode>
    );
    const view = render(tree);
    view.rerender(tree);
    await user.click(screen.getByRole("link", { name: "필터 변경" }));
    expect(api.events()).toEqual([
      { feature_id: "system.settings", visit_id: expect.stringMatching(/^[a-f0-9]{32}$/), event: "visit" },
    ]);
    await user.click(screen.getByRole("link", { name: "다른 기능" }));
    await user.click(screen.getByRole("link", { name: "다시 진입" }));
    const events = api.events();
    expect(events.map((event) => event.feature_id)).toEqual([
      "system.settings",
      "overview",
      "system.settings",
    ]);
    expect(new Set(events.map((event) => event.visit_id)).size).toBe(3);
    expect(JSON.stringify(events)).not.toMatch(/private-|prompt|team|user|tab=|\/system/);
  });

  it("creates a new memory-only visit on account changes and real unmount/remount", () => {
    const api = observeRequests();
    const storage = vi.spyOn(Storage.prototype, "setItem");
    const view = render(<FeatureTelemetry feature={settingsFeature} />);
    view.rerender(<FeatureTelemetry feature={{ ...settingsFeature }} />);
    expect(api.events()).toHaveLength(1);
    authState.current = testAuth({ telemetryEnabled: true, user: { id: "another-private-user" } });
    view.rerender(<FeatureTelemetry feature={settingsFeature} />);
    view.unmount();
    render(<FeatureTelemetry feature={settingsFeature} />);
    const events = api.events();
    expect(events).toHaveLength(3);
    expect(new Set(events.map((event) => event.visit_id)).size).toBe(3);
    expect(storage).not.toHaveBeenCalled();
    expect(JSON.stringify(events)).not.toContain("another-private-user");
  });
});

describe("legacy fallback observation", () => {
  it.each(["primary", "keyboard", "middle", "modified-primary"])(
    "observes %s navigation once, sharing the visit ID",
    async (activation) => {
      const api = observeRequests();
      const user = userEvent.setup();
      render(
        <FeatureTelemetry feature={settingsFeature}>
          <LegacyLink href="#legacy">기존 화면</LegacyLink>
        </FeatureTelemetry>,
      );
      const link = screen.getByRole("link");
      if (activation === "keyboard") {
        await user.tab();
        expect(link).toHaveFocus();
        await user.keyboard("{Enter}");
      } else {
        const event = new MouseEvent(activation === "middle" ? "auxclick" : "click", {
          bubbles: true,
          cancelable: true,
          button: activation === "middle" ? 1 : 0,
          ctrlKey: activation === "modified-primary",
        });
        fireEvent(link, event);
        expect(event.defaultPrevented).toBe(false);
      }
      expect(api.events().map((event) => event.event)).toEqual(["visit", "legacy_fallback"]);
      fireEvent.click(link);
      const [visit, fallback] = api.events();
      expect(api.events()).toHaveLength(2);
      expect(fallback).toEqual({ ...visit, event: "legacy_fallback" });
      expect(link).toHaveAttribute("href", "#legacy");
    },
  );

  it.each(["global-denied", "feature-denied", "retired"])(
    "does not observe a fallback when it is %s",
    (restriction) => {
      const api = observeRequests();
      if (restriction === "global-denied") authState.current.legacyFallback = false;
      const currentFeature: MigrationFeature = {
        ...settingsFeature,
        fallbackEnabled: restriction !== "feature-denied",
        status: restriction === "retired" ? "retired" : "preview",
      };
      render(
        <FeatureTelemetry feature={currentFeature}>
          <LegacyLink href="#legacy">기존 화면</LegacyLink>
        </FeatureTelemetry>,
      );
      fireEvent.click(screen.getByRole("link"));
      expect(api.events().map((event) => event.event)).toEqual(["visit"]);
    },
  );

  it("ignores right-button auxiliary clicks without cancelling navigation", () => {
    const api = observeRequests();
    render(
      <FeatureTelemetry feature={settingsFeature}>
        <LegacyLink href="#legacy">기존 화면</LegacyLink>
      </FeatureTelemetry>,
    );
    const event = new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 2 });
    fireEvent(screen.getByRole("link"), event);
    expect(event.defaultPrevented).toBe(false);
    expect(api.events().map((entry) => entry.event)).toEqual(["visit"]);
  });

  it("ignores caller-cancelled primary or middle clicks", () => {
    const api = observeRequests();
    const preventNavigation: MouseEventHandler<HTMLAnchorElement> = (event) => event.preventDefault();
    render(
      <FeatureTelemetry feature={settingsFeature}>
        <LegacyLink href="#legacy" onClick={preventNavigation} onAuxClick={preventNavigation}>
          기존 화면
        </LegacyLink>
      </FeatureTelemetry>,
    );
    const link = screen.getByRole("link");
    fireEvent.contextMenu(link);
    fireEvent.click(link);
    fireEvent(link, new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }));
    expect(api.events().map((event) => event.event)).toEqual(["visit"]);
  });

  it("never blocks link navigation when telemetry rejects", async () => {
    const api = observeRequests();
    api.request.mockRejectedValue(new AppError("expired", { kind: "auth", status: 401 }));
    render(
      <FeatureTelemetry feature={settingsFeature}>
        <LegacyLink href="#legacy">기존 화면</LegacyLink>
      </FeatureTelemetry>,
    );
    const link = screen.getByRole("link");
    const event = createEvent.click(link, { button: 0, cancelable: true });
    fireEvent(link, event);
    await Promise.resolve();
    expect(event.defaultPrevented).toBe(false);
    expect(link).toHaveAttribute("href", "#legacy");
    expect(api.events().map((event) => event.event)).toEqual(["visit", "legacy_fallback"]);
  });
});
