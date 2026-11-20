import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RootLegacyRecovery } from "./RootLegacyRecovery";
import { ApiClient, apiClient, type ApiRequestOptions } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { AppError } from "@/shared/api/error";
import { legacyRecoveryNavigation, legacyRecoveryTimeoutMs } from "@/shared/api/legacy-recovery";
import type { UIBootstrap } from "@/shared/api/schemas";
import { tokenStore } from "@/shared/auth/token-store";
function mockRecovery(
  handler: (
    endpoint: typeof endpoints.uiBootstrap,
    options?: ApiRequestOptions<typeof endpoints.uiBootstrap>,
  ) => UIBootstrap | Promise<UIBootstrap>,
) {
  return vi.spyOn(apiClient, "request").mockImplementation(async (endpoint, ...args) => {
    expect(endpoint).toBe(endpoints.uiBootstrap);
    return (await handler(
      endpoints.uiBootstrap,
      args[0] as ApiRequestOptions<typeof endpoints.uiBootstrap> | undefined,
    )) as never;
  });
}

const privateText = "SYNTHETIC_PRIVATE_RECOVERY_ERROR";
function bootstrap(): UIBootstrap {
  return {
    backend_version: "v0.86.163",
    ui_version: "v0.86.163",
    api_version: "v1",
    capabilities: { raw_prompt_view: false },
    ui: {
      enabled: true,
      default_entry: "/app/overview",
      legacy_fallback: true,
      feedback_enabled: false,
      telemetry_enabled: false,
    },
    authentication: {
      enabled: true,
      authenticated: true,
      mode: "session",
      keycloak_enabled: false,
      allow_local_login: true,
      sso_login_url: "/auth/keycloak/login",
    },
    user: {
      id: "public-admin",
      team_id: "public-team",
      email: "public@example.invalid",
      role: "admin",
      roles: ["admin"],
      scopes: ["admin:read"],
      features: {},
    },
    roles: ["admin"],
    permissions: ["admin:read"],
    allowed_features: [],
    migration_registry: [],
    system_status: { status: "healthy" },
    legacy_route_map: {},
  };
}
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const button = (): HTMLElement =>
  screen.getByRole("button", { name: /기존 관리자 (화면 열기|접근 확인 중…)/ });
const mount = (): ReturnType<typeof render> =>
  render(
    <StrictMode>
      <RootLegacyRecovery />
    </StrictMode>,
  );

describe("root Legacy recovery owns fresh policy checks outside failed providers", () => {
  beforeEach(() => {
    tokenStore.clearAll();
    vi.spyOn(legacyRecoveryNavigation, "open").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(["session", "legacy_token", "open"] as const)(
    "only navigates after an explicit current %s decision",
    async (mode) => {
      const data = bootstrap();
      data.authentication.mode = mode;
      data.authentication.enabled = mode === "session";
      const request = mockRecovery(() => data);
      mount();
      expect(request).not.toHaveBeenCalled();
      await userEvent.click(button());
      await waitFor(() => expect(legacyRecoveryNavigation.open).toHaveBeenCalledTimes(1));
      expect(request).toHaveBeenCalledTimes(1);
      expect(request.mock.calls[0]?.[0]).toBe(endpoints.uiBootstrap);
      const options = request.mock.calls[0]?.[1];
      expect(options).toMatchObject({
        retryUnauthorized: false,
        cache: "no-store",
        routeId: "recovery.legacy",
        timeoutMs: legacyRecoveryTimeoutMs,
      });
      expect(new Headers(options?.headers).get("X-Request-ID")).toMatch(/^ui-recovery-[0-9a-f]{32}$/u);
    },
  );

  it("checks again after opt-out without trusting a cached decision", async () => {
    let allow = false;
    const request = mockRecovery(() => {
      const data = bootstrap();
      data.ui.legacy_fallback = allow;
      return data;
    });
    mount();
    await userEvent.click(button());
    expect(await screen.findByRole("status")).toHaveTextContent(
      "현재 설정에서 기존 관리자 이동을 허용하지 않습니다.",
    );
    expect(legacyRecoveryNavigation.open).not.toHaveBeenCalled();
    allow = true;
    await userEvent.click(button());
    await waitFor(() => expect(legacyRecoveryNavigation.open).toHaveBeenCalledTimes(1));
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each(["session", "legacy_token"] as const)(
    "rejects unauthenticated %s even if fallback is enabled",
    async (mode) => {
      mockRecovery(() => {
        const data = bootstrap();
        data.authentication.mode = mode;
        data.authentication.authenticated = false;
        data.user = null;
        return data;
      });
      mount();
      await userEvent.click(button());
      await waitFor(() =>
        expect(screen.getByRole("status")).toHaveTextContent("로그인 상태를 확인할 수 없습니다."),
      );
      expect(legacyRecoveryNavigation.open).not.toHaveBeenCalled();
    },
  );

  it.each(["user scopes", "permissions"] as const)(
    "does not infer admin permission from contradictory %s",
    async (field) => {
      mockRecovery(() => {
        const data = bootstrap();
        if (field === "permissions") data.permissions = [];
        else if (data.user) data.user.scopes = [];
        return data;
      });
      mount();
      await userEvent.click(button());
      await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("열 권한이 없습니다."));
      expect(legacyRecoveryNavigation.open).not.toHaveBeenCalled();
    },
  );

  it("keeps keyboard focus and ignores repeated submissions during one pending check", async () => {
    const gate = deferred<UIBootstrap>();
    const request = mockRecovery(() => gate.promise);
    mount();
    const user = userEvent.setup();
    button().focus();
    await user.keyboard("{Enter}{Enter} ");
    expect(button()).toHaveAttribute("aria-disabled", "true");
    expect(button()).toHaveFocus();
    await user.click(button());
    expect(request).toHaveBeenCalledTimes(1);
    const data = bootstrap();
    data.ui.legacy_fallback = false;
    await act(async () => {
      gate.resolve(data);
    });
    expect(button()).toHaveAttribute("aria-disabled", "false");
    expect(button()).toHaveFocus();
  });

  it.each(["session", "logout"] as const)(
    "retires a delayed decision on %s and preserves a later attempt",
    async (kind) => {
      const old = deferred<UIBootstrap>();
      let calls = 0;
      let oldSignal: AbortSignal | undefined;
      mockRecovery((_endpoint, options) => {
        calls++;
        if (calls === 1) {
          oldSignal = options?.signal;
          return old.promise;
        }
        return bootstrap();
      });
      mount();
      await userEvent.click(button());
      act(() => {
        if (kind === "session")
          tokenStore.saveTokens({ access_token: "public-new-access", refresh_token: "public-new-refresh" });
        else
          window.dispatchEvent(
            new StorageEvent("storage", {
              key: "vibe.app.auth.logout-event",
              newValue: "1795096000000-root",
            }),
          );
      });
      expect(oldSignal?.aborted).toBe(true);
      expect(screen.getByRole("status")).toHaveTextContent("로그인 상태가 변경");
      await userEvent.click(button());
      await waitFor(() => expect(legacyRecoveryNavigation.open).toHaveBeenCalledTimes(1));
      await act(async () => {
        old.resolve(bootstrap());
      });
      expect(legacyRecoveryNavigation.open).toHaveBeenCalledTimes(1);
    },
  );

  it("unmount cancels its query and a late response cannot navigate", async () => {
    const gate = deferred<UIBootstrap>();
    let signal: AbortSignal | undefined;
    mockRecovery((_endpoint, options) => {
      signal = options?.signal;
      return gate.promise;
    });
    const view = mount();
    await userEvent.click(button());
    view.unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      gate.resolve(bootstrap());
    });
    expect(legacyRecoveryNavigation.open).not.toHaveBeenCalled();
  });

  it("bounds waiting even when a deferred client ignores cancellation", async () => {
    vi.useFakeTimers();
    const gate = deferred<UIBootstrap>();
    let signal: AbortSignal | undefined;
    mockRecovery((_endpoint, options) => {
      signal = options?.signal;
      return gate.promise;
    });
    mount();
    fireEvent.click(button());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(legacyRecoveryTimeoutMs + 1);
    });
    expect(signal?.aborted).toBe(true);
    expect(screen.getByRole("status")).toHaveTextContent("접근 확인 시간이 초과");
    expect(button()).toHaveAttribute("aria-disabled", "false");
    await act(async () => {
      gate.resolve(bootstrap());
    });
    expect(legacyRecoveryNavigation.open).not.toHaveBeenCalled();
  });

  it.each([401, 403, 503])("shows safe guidance for HTTP %s without automatic retries", async (status) => {
    const request = mockRecovery(() => {
      throw new AppError(privateText, { kind: "http", status, requestId: privateText });
    });
    mount();
    await userEvent.click(button());
    await waitFor(() => expect(button()).toHaveAttribute("aria-disabled", "false"));
    expect(request).toHaveBeenCalledTimes(1);
    expect(legacyRecoveryNavigation.open).not.toHaveBeenCalled();
    expect(document.body).not.toHaveTextContent(privateText);
  });

  it("only displays the server echo of the generated recovery request ID", async () => {
    let requestId = "";
    mockRecovery((_endpoint, options) => {
      requestId = new Headers(options?.headers).get("X-Request-ID") ?? "";
      throw new AppError(privateText, { kind: "http", status: 503, requestId });
    });
    mount();
    await userEvent.click(button());
    expect(await screen.findByText("요청 ID: " + requestId)).toBeVisible();
    expect(document.body).not.toHaveTextContent(privateText);
  });

  it("uses the real typed client to reject an invalid bootstrap contract", async () => {
    const client = new ApiClient({
      fetch: vi.fn(
        async () =>
          new Response(JSON.stringify({ secret: privateText }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    });
    vi.spyOn(apiClient, "request").mockImplementation(client.request.bind(client));
    mount();
    await userEvent.click(button());
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("접근을 확인하지 못했습니다."));
    expect(legacyRecoveryNavigation.open).not.toHaveBeenCalled();
    expect(document.body).not.toHaveTextContent(privateText);
  });
});
