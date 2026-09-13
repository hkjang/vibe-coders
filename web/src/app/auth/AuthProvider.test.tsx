import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type PropsWithChildren } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AuthProvider, useAuth } from "@/app/auth/AuthProvider";
import { formatSsoFailure } from "@/app/auth/sso-errors";
import { apiClient } from "@/shared/api/client";
import { endpoints, type ApiEndpointBase } from "@/shared/api/endpoints";
import { AppError } from "@/shared/api/error";
import type { UIBootstrap } from "@/shared/api/schemas";
import { tokenStore } from "@/shared/auth/token-store";
import { authNavigation } from "@/shared/auth/logout-navigation";
import { silentSsoNavigation } from "@/shared/auth/silent-sso";

const bootstrap: UIBootstrap = {
  backend_version: "v0.80.0",
  ui_version: "v0.80.0",
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
    keycloak_enabled: true,
    allow_local_login: false,
    sso_login_url: "/auth/keycloak/login",
    credential_prefixes: ["corp_", "svc_"],
  },
  user: {
    id: "admin-1",
    email: "admin@example.test",
    role: "admin",
    roles: ["admin"],
    team_id: "platform",
    scopes: ["admin:read"],
    features: {},
  },
  roles: ["admin"],
  permissions: ["admin:read"],
  allowed_features: ["overview"],
  migration_registry: [],
  system_status: { status: "healthy" },
  legacy_route_map: {},
};

const fallbackSsoStatus = {
  keycloak_enabled: false,
  allow_local_login: true,
  login_url: endpoints.auth.keycloakLogin.path,
} as const;

function TestProviders({ children }: PropsWithChildren): React.JSX.Element {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;
}

function LogoutHarness(): React.JSX.Element {
  const auth = useAuth();
  return <button onClick={() => void auth.logout()}>{auth.mode === "loading" ? "loading" : "logout"}</button>;
}

function RuntimeConfigHarness(): React.JSX.Element {
  const auth = useAuth();
  return <span>{auth.uiEnabled ? "enabled" : "disabled"}</span>;
}

function AuthStateHarness(): React.JSX.Element {
  const auth = useAuth();
  return (
    <div>
      <span>{auth.mode}</span>
      <span>{auth.sso.keycloak_enabled ? "sso-enabled" : "sso-disabled"}</span>
      <span>{auth.sso.allow_local_login ? "local-enabled" : "local-disabled"}</span>
    </div>
  );
}

function AuthErrorHarness(): React.JSX.Element {
  const auth = useAuth();
  return <span>{auth.error ?? "오류 없음"}</span>;
}

function CredentialPrefixHarness(): React.JSX.Element {
  const auth = useAuth();
  return <span>{auth.credentialPrefixes.join("|")}</span>;
}

afterEach(() => {
  tokenStore.clearAll();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});

describe("AuthProvider Keycloak logout", () => {
  it("reloads anonymous Keycloak-only bootstrap after stale tokens are rejected", async () => {
    tokenStore.saveTokens({ access_token: "stale-access", refresh_token: "stale-refresh" });
    let bootstrapCalls = 0;
    const anonymousBootstrap: UIBootstrap = {
      ...bootstrap,
      authentication: { ...bootstrap.authentication, authenticated: false },
      user: null,
      roles: [],
      permissions: [],
    };
    vi.spyOn(apiClient, "request").mockImplementation((async (endpoint: ApiEndpointBase) => {
      if (endpoint.path !== endpoints.uiBootstrap.path) {
        throw new Error(`unexpected request ${endpoint.path}`);
      }
      bootstrapCalls += 1;
      if (bootstrapCalls === 1) {
        throw new AppError("expired", { kind: "auth", status: 401 });
      }
      return anonymousBootstrap;
    }) as typeof apiClient.request);

    render(
      <TestProviders>
        <AuthProvider>
          <AuthStateHarness />
        </AuthProvider>
      </TestProviders>,
    );

    await waitFor(() => expect(screen.getByText("anonymous")).toBeVisible());
    expect(screen.getByText("sso-enabled")).toBeVisible();
    expect(screen.getByText("local-disabled")).toBeVisible();
    expect(bootstrapCalls).toBe(2);
    expect(tokenStore.getAccessToken()).toBe("");
    expect(tokenStore.getRefreshToken()).toBe("");
  });

  it("scrubs the one-time callback code before exchanging it and then bootstraps the session", async () => {
    window.history.replaceState(null, "", "/app/login#kc_code=once-42");
    tokenStore.saveTokens({ access_token: "stale-access", refresh_token: "stale-refresh" });
    const requestOrder: string[] = [];
    const request = vi.spyOn(apiClient, "request").mockImplementation((async (endpoint: ApiEndpointBase) => {
      requestOrder.push(endpoint.path);
      if (endpoint.path === endpoints.auth.ssoExchange.path) {
        expect(window.location.hash).toBe("");
        expect(tokenStore.getAccessToken()).toBe("");
        return { access_token: "sso-access", refresh_token: "sso-refresh", token_type: "Bearer" };
      }
      if (endpoint.path === endpoints.uiBootstrap.path) return bootstrap;
      throw new Error(`unexpected request ${endpoint.path}`);
    }) as typeof apiClient.request);

    render(
      <TestProviders>
        <AuthProvider>
          <LogoutHarness />
        </AuthProvider>
      </TestProviders>,
    );

    await waitFor(() => expect(screen.getByRole("button", { name: "logout" })).toBeEnabled());
    expect(requestOrder.slice(0, 2)).toEqual([endpoints.auth.ssoExchange.path, endpoints.uiBootstrap.path]);
    const exchangeCall = request.mock.calls.find(
      ([endpoint]) => endpoint.path === endpoints.auth.ssoExchange.path,
    );
    expect(exchangeCall?.[1]).toMatchObject({ body: { code: "once-42" } });
    expect(tokenStore.getAccessToken()).toBe("sso-access");
    expect(tokenStore.getRefreshToken()).toBe("sso-refresh");
  });

  it("revokes the internal session, clears local tokens, then follows a validated end-session URL", async () => {
    tokenStore.saveTokens({ access_token: "access", refresh_token: "refresh" });
    const request = vi.spyOn(apiClient, "request").mockImplementation((async (endpoint: ApiEndpointBase) => {
      if (endpoint.path === endpoints.uiBootstrap.path) return bootstrap;
      if (endpoint.path === endpoints.auth.keycloakLogout.path) {
        return { status: "logged_out", end_session_url: "https://idp.example.test/logout" };
      }
      throw new Error(`unexpected request ${endpoint.path}`);
    }) as typeof apiClient.request);
    const navigate = vi.spyOn(authNavigation, "toEndSession").mockImplementation(() => undefined);
    const user = userEvent.setup();

    render(
      <TestProviders>
        <AuthProvider>
          <LogoutHarness />
        </AuthProvider>
      </TestProviders>,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "logout" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "logout" }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith("https://idp.example.test/logout"));
    const logoutCall = request.mock.calls.find(
      ([endpoint]) => endpoint.path === endpoints.auth.keycloakLogout.path,
    );
    expect(logoutCall).toBeDefined();
    expect(logoutCall?.[1]).toMatchObject({
      body: { refresh_token: "refresh", return_to: "/app/login" },
    });
    expect(tokenStore.getAccessToken()).toBe("");
    expect(tokenStore.getRefreshToken()).toBe("");
  });
});

describe("AuthProvider SSO callback errors", () => {
  it.each([
    [
      "user_provisioning_failed",
      "SSO 사용자 정보를 준비하지 못했습니다. 잠시 후 다시 시도하거나 관리자에게 문의하세요. (진단 코드: user_provisioning_failed)",
    ],
    [
      "invalid_or_expired_state",
      "SSO 로그인 상태가 만료되었거나 올바르지 않습니다. 로그인을 다시 시작하세요. (진단 코드: invalid_or_expired_state)",
    ],
    [
      "token_exchange_failed",
      "SSO 인증 토큰을 발급받지 못했습니다. 잠시 후 다시 시도하세요. (진단 코드: token_exchange_failed)",
    ],
    [
      "sso_exchange_failed",
      "SSO 세션을 교환하지 못했습니다. 로그인을 다시 시작하세요. (진단 코드: sso_exchange_failed)",
    ],
  ])("maps the stable %s code to a Korean message", (code, expected) => {
    expect(formatSsoFailure(code)).toBe(expected);
  });

  it("maps an unknown callback value to the generic stable code without reflecting it", () => {
    const unsafe = "client_secret=do-not-reflect";
    const message = formatSsoFailure(unsafe);

    expect(message).toContain("진단 코드: sso_callback_failed");
    expect(message).not.toContain(unsafe);
  });

  it("shows the provisioning guidance after scrubbing the callback fragment", async () => {
    window.history.replaceState(null, "", "/app/login#kc_error=user_provisioning_failed");
    const anonymousBootstrap: UIBootstrap = {
      ...bootstrap,
      authentication: { ...bootstrap.authentication, authenticated: false },
      user: null,
      roles: [],
      permissions: [],
    };
    vi.spyOn(apiClient, "request").mockImplementation((async (endpoint: ApiEndpointBase) => {
      if (endpoint.path === endpoints.uiBootstrap.path) return anonymousBootstrap;
      throw new Error(`unexpected request ${endpoint.path}`);
    }) as typeof apiClient.request);

    render(
      <TestProviders>
        <AuthProvider>
          <AuthErrorHarness />
        </AuthProvider>
      </TestProviders>,
    );

    expect(
      await screen.findByText(
        "SSO 사용자 정보를 준비하지 못했습니다. 잠시 후 다시 시도하거나 관리자에게 문의하세요. (진단 코드: user_provisioning_failed)",
      ),
    ).toBeVisible();
    expect(window.location.hash).toBe("");
  });

  it("does not expose an exchange error's internal message", async () => {
    window.history.replaceState(null, "", "/app/login#kc_code=once-sensitive");
    const anonymousBootstrap: UIBootstrap = {
      ...bootstrap,
      authentication: { ...bootstrap.authentication, authenticated: false },
      user: null,
      roles: [],
      permissions: [],
    };
    const sensitiveInternalMessage = "exchange failed at https://idp.test/token?client_secret=private";
    vi.spyOn(apiClient, "request").mockImplementation((async (endpoint: ApiEndpointBase) => {
      if (endpoint.path === endpoints.auth.ssoExchange.path) {
        throw new AppError(sensitiveInternalMessage, {
          code: "sso_session_failed",
          kind: "http",
          status: 500,
        });
      }
      if (endpoint.path === endpoints.uiBootstrap.path) return anonymousBootstrap;
      throw new Error(`unexpected request ${endpoint.path}`);
    }) as typeof apiClient.request);

    render(
      <TestProviders>
        <AuthProvider>
          <AuthErrorHarness />
        </AuthProvider>
      </TestProviders>,
    );

    expect(
      await screen.findByText(
        "SSO 세션을 준비하지 못했습니다. 잠시 후 다시 시도하세요. (진단 코드: sso_session_failed)",
      ),
    ).toBeVisible();
    expect(document.body).not.toHaveTextContent(sensitiveInternalMessage);
  });
});

describe("AuthProvider runtime bootstrap refresh", () => {
  it("uses the authenticated fallback credential-prefix registry when the combined bootstrap fails", async () => {
    vi.spyOn(apiClient, "request").mockImplementation((async (endpoint: ApiEndpointBase) => {
      if (endpoint.path === endpoints.uiBootstrap.path) {
        throw new AppError("bootstrap unavailable", { kind: "http", status: 503 });
      }
      if (endpoint.path === endpoints.auth.ssoStatus.path) return fallbackSsoStatus;
      if (endpoint.path === endpoints.auth.me.path) {
        return {
          auth_enabled: true,
          credential_prefixes: ["corp_", "old_"],
          expires_at: 2_000_000_000,
          user: bootstrap.user,
          version: "v0.83.0",
        };
      }
      throw new Error(`unexpected request ${endpoint.path}`);
    }) as typeof apiClient.request);

    render(
      <TestProviders>
        <AuthProvider>
          <CredentialPrefixHarness />
        </AuthProvider>
      </TestProviders>,
    );

    expect(await screen.findByText("corp_|old_")).toBeVisible();
  });

  it("fails closed when a legacy fallback response has no credential-prefix registry", async () => {
    vi.spyOn(apiClient, "request").mockImplementation((async (endpoint: ApiEndpointBase) => {
      if (endpoint.path === endpoints.uiBootstrap.path) {
        throw new AppError("bootstrap unavailable", { kind: "http", status: 503 });
      }
      if (endpoint.path === endpoints.auth.ssoStatus.path) return fallbackSsoStatus;
      if (endpoint.path === endpoints.auth.me.path) {
        return {
          auth_enabled: true,
          user: bootstrap.user,
          version: "v0.82.2",
        };
      }
      throw new Error(`unexpected request ${endpoint.path}`);
    }) as typeof apiClient.request);

    render(
      <TestProviders>
        <AuthProvider>
          <AuthStateHarness />
        </AuthProvider>
      </TestProviders>,
    );

    expect(await screen.findByText("error")).toBeVisible();
  });

  it("refreshes runtime UI flags on visibility and bounded active-tab polling without loading flicker", async () => {
    let currentBootstrap = bootstrap;
    let poll: (() => void) | undefined;
    vi.spyOn(window, "setInterval").mockImplementation((handler: TimerHandler, timeout?: number) => {
      if (timeout === 60_000 && typeof handler === "function") poll = handler as () => void;
      return 1;
    });
    const request = vi.spyOn(apiClient, "request").mockImplementation((async (endpoint: ApiEndpointBase) => {
      if (endpoint.path === endpoints.uiBootstrap.path) return currentBootstrap;
      throw new Error(`unexpected request ${endpoint.path}`);
    }) as typeof apiClient.request);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });

    render(
      <TestProviders>
        <AuthProvider>
          <RuntimeConfigHarness />
        </AuthProvider>
      </TestProviders>,
    );
    await waitFor(() => expect(screen.getByText("enabled")).toBeVisible());

    currentBootstrap = { ...bootstrap, ui: { ...bootstrap.ui, enabled: false } };
    document.dispatchEvent(new Event("visibilitychange"));

    await waitFor(() => expect(screen.getByText("disabled")).toBeVisible());
    expect(screen.queryByText("loading")).not.toBeInTheDocument();

    currentBootstrap = bootstrap;
    expect(poll).toBeDefined();
    act(() => poll?.());
    await waitFor(() => expect(screen.getByText("enabled")).toBeVisible());
    expect(
      request.mock.calls.filter(([endpoint]) => endpoint.path === endpoints.uiBootstrap.path),
    ).toHaveLength(3);
  });
});

describe("AuthProvider silent SSO", () => {
  const anonymousAutoLogin: UIBootstrap = {
    ...bootstrap,
    authentication: { ...bootstrap.authentication, authenticated: false, auto_login: true },
    user: null,
    roles: [],
    permissions: [],
  };

  function mockAnonymousBootstrap(data: UIBootstrap = anonymousAutoLogin): ReturnType<typeof vi.spyOn> {
    return vi.spyOn(apiClient, "request").mockImplementation((async (endpoint: ApiEndpointBase) => {
      if (endpoint.path === endpoints.uiBootstrap.path) return data;
      if (endpoint.path === endpoints.auth.keycloakLogout.path) {
        return { status: "logged_out", end_session_url: "" };
      }
      throw new Error(`unexpected request ${endpoint.path}`);
    }) as typeof apiClient.request);
  }

  function renderState(): void {
    render(
      <TestProviders>
        <AuthProvider>
          <AuthStateHarness />
        </AuthProvider>
      </TestProviders>,
    );
  }

  it("sends an anonymous deep-link visitor to the provider once with prompt=none and the return path", async () => {
    window.history.replaceState(null, "", "/app/traces/abc");
    mockAnonymousBootstrap();
    const navigate = vi.spyOn(silentSsoNavigation, "toProvider").mockImplementation(() => undefined);

    renderState();

    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    const target = new URL(navigate.mock.calls[0]?.[0] ?? "");
    expect(target.pathname).toBe(endpoints.auth.keycloakLogin.path);
    expect(target.searchParams.get("prompt")).toBe("none");
    expect(target.searchParams.get("return_to")).toBe("/app/traces/abc");

    // A re-render with the same anonymous state must not start a second attempt.
    await waitFor(() => expect(screen.getByText("anonymous")).toBeVisible());
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("does nothing while auto_login is off even though SSO is enabled", async () => {
    window.history.replaceState(null, "", "/app/overview");
    mockAnonymousBootstrap({
      ...anonymousAutoLogin,
      authentication: { ...anonymousAutoLogin.authentication, auto_login: false },
    });
    const navigate = vi.spyOn(silentSsoNavigation, "toProvider").mockImplementation(() => undefined);

    renderState();

    await waitFor(() => expect(screen.getByText("anonymous")).toBeVisible());
    expect(navigate).not.toHaveBeenCalled();
  });

  it("does not retry from the login screen the callback sent the visitor to", async () => {
    window.history.replaceState(null, "", "/app/login?sso=none&return_to=%2Fapp%2Ftraces%2Fabc");
    mockAnonymousBootstrap();
    const navigate = vi.spyOn(silentSsoNavigation, "toProvider").mockImplementation(() => undefined);

    renderState();

    await waitFor(() => expect(screen.getByText("anonymous")).toBeVisible());
    expect(navigate).not.toHaveBeenCalled();
  });

  it("does not start from an SSO callback landing that carried an error", async () => {
    window.history.replaceState(null, "", "/app/overview#kc_error=access_denied");
    mockAnonymousBootstrap();
    const navigate = vi.spyOn(silentSsoNavigation, "toProvider").mockImplementation(() => undefined);

    renderState();

    await waitFor(() => expect(screen.getByText("anonymous")).toBeVisible());
    expect(navigate).not.toHaveBeenCalled();
  });

  it("stays signed out after the user logs out on purpose", async () => {
    window.history.replaceState(null, "", "/app/overview");
    let current: UIBootstrap = {
      ...bootstrap,
      authentication: { ...bootstrap.authentication, auto_login: true },
    };
    vi.spyOn(apiClient, "request").mockImplementation((async (endpoint: ApiEndpointBase) => {
      if (endpoint.path === endpoints.uiBootstrap.path) return current;
      if (endpoint.path === endpoints.auth.keycloakLogout.path) {
        return { status: "logged_out", end_session_url: "" };
      }
      throw new Error(`unexpected request ${endpoint.path}`);
    }) as typeof apiClient.request);
    const navigate = vi.spyOn(silentSsoNavigation, "toProvider").mockImplementation(() => undefined);
    const user = userEvent.setup();

    render(
      <TestProviders>
        <AuthProvider>
          <LogoutHarness />
          <AuthStateHarness />
        </AuthProvider>
      </TestProviders>,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "logout" })).toBeEnabled());
    current = anonymousAutoLogin;
    await user.click(screen.getByRole("button", { name: "logout" }));

    await waitFor(() => expect(screen.getByText("anonymous")).toBeVisible());
    expect(navigate).not.toHaveBeenCalled();
  });
});
