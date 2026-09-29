import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type PropsWithChildren } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AuthProvider, useAuth } from "@/app/auth/AuthProvider";
import { formatSsoFailure } from "@/app/auth/sso-errors";
import { ApiClient, apiClient } from "@/shared/api/client";
import { endpoints, type ApiEndpointBase } from "@/shared/api/endpoints";
import { AppError } from "@/shared/api/error";
import type { UIBootstrap } from "@/shared/api/schemas";
import { subscribeToLogout, tokenStore } from "@/shared/auth/token-store";
import { authNavigation } from "@/shared/auth/logout-navigation";
import { silentSsoNavigation } from "@/shared/auth/silent-sso";
import { mockApi } from "@/test/api";

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

function SessionBoundaryHarness(): React.JSX.Element {
  const auth = useAuth();
  return (
    <>
      <output>{auth.mode}</output>
      <button onClick={() => void auth.logout()}>end session</button>
      <button onClick={() => void auth.login("new@example.test", "password")}>new login</button>
    </>
  );
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

function TelemetryAuthHarness(): React.JSX.Element {
  const auth = useAuth();
  return (
    <div>
      <output data-testid="telemetry-enabled">{String(auth.telemetryEnabled)}</output>
      <output data-testid="telemetry-auth-mode">{auth.mode}</output>
      <output data-testid="telemetry-ui-enabled">{String(auth.uiEnabled)}</output>
      <button onClick={() => void auth.retry()}>telemetry retry</button>
      <button onClick={() => void auth.logout()}>telemetry logout</button>
      <button onClick={() => void auth.setLegacyToken("replacement-token").catch(() => undefined)}>
        replace telemetry token
      </button>
    </div>
  );
}

function renderTelemetryAuth() {
  return render(
    <TestProviders>
      <AuthProvider>
        <TelemetryAuthHarness />
      </AuthProvider>
    </TestProviders>,
  );
}

function deferredBootstrap() {
  let resolve: (value: UIBootstrap) => void = () => {
    throw new Error("Bootstrap resolver was not initialized");
  };
  let reject: (reason: unknown) => void = () => {
    throw new Error("Bootstrap rejecter was not initialized");
  };
  const promise = new Promise<UIBootstrap>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}

function deferredLogout() {
  let resolve: () => void = () => {
    throw new Error("Logout resolver was not initialized");
  };
  let reject: (reason: unknown) => void = () => {
    throw new Error("Logout rejecter was not initialized");
  };
  const promise = new Promise<void>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  tokenStore.clearAll();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});

describe("AuthProvider Keycloak logout", () => {
  it("preserves old revoke credentials and SSO navigation through the real epoch-aware API client", async () => {
    let resolve!: (response: Response) => void;
    const pending = new Promise<Response>((accept) => {
      resolve = accept;
    });
    const json = (value: unknown) =>
      new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
    tokenStore.saveTokens({ access_token: "old-access", refresh_token: "old-refresh" });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === endpoints.uiBootstrap.path) return json(bootstrap);
      expect(String(input)).toBe(endpoints.auth.keycloakLogout.path);
      expect(tokenStore.getAccessToken()).toBe("");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer old-access");
      expect(JSON.parse(String(init?.body))).toEqual({
        refresh_token: "old-refresh",
        return_to: "/app/login",
      });
      return pending;
    });
    const client = new ApiClient({ fetch: fetchMock });
    vi.spyOn(apiClient, "request").mockImplementation(client.request.bind(client));
    const navigate = vi.spyOn(authNavigation, "toEndSession").mockImplementation(() => undefined);
    render(
      <TestProviders>
        <AuthProvider>
          <LogoutHarness />
          <AuthStateHarness />
        </AuthProvider>
      </TestProviders>,
    );
    await screen.findByText("authenticated");
    await userEvent.setup().click(screen.getByRole("button", { name: "logout" }));
    expect(screen.getByText("anonymous")).toBeVisible();
    await act(async () =>
      resolve(json({ status: "logged_out", end_session_url: "https://idp.example.test/logout" })),
    );
    expect(navigate).toHaveBeenCalledWith("https://idp.example.test/logout");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(["success", "failure"])(
    "does not let a late remote logout %s clear or redirect a new login",
    async (outcome) => {
      let resolve!: (value: { status: string; end_session_url: string }) => void;
      let reject!: (error: Error) => void;
      const pending = new Promise<{ status: string; end_session_url: string }>((accept, refuse) => {
        resolve = accept;
        reject = refuse;
      });
      tokenStore.saveTokens({ access_token: "old-access", refresh_token: "old-refresh" });
      const queryClient = new QueryClient();
      const request = vi.spyOn(apiClient, "request").mockImplementation((async (
        endpoint: ApiEndpointBase,
      ) => {
        if (endpoint.path === endpoints.uiBootstrap.path) return bootstrap;
        if (endpoint.path === endpoints.auth.keycloakLogout.path) return pending;
        if (endpoint.path === endpoints.auth.login.path)
          return { access_token: "new-access", refresh_token: "new-refresh" };
        throw new Error(`unexpected ${endpoint.path}`);
      }) as typeof apiClient.request);
      const navigate = vi.spyOn(authNavigation, "toEndSession").mockImplementation(() => undefined);
      render(
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <SessionBoundaryHarness />
          </AuthProvider>
        </QueryClientProvider>,
      );
      await screen.findByText("authenticated");
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "end session" }));
      expect(screen.getByText("anonymous")).toBeVisible();
      const call = request.mock.calls.find(
        ([endpoint]) => endpoint.path === endpoints.auth.keycloakLogout.path,
      );
      expect(call?.[1]).toMatchObject({
        headers: { Authorization: "Bearer old-access" },
        body: { refresh_token: "old-refresh" },
      });
      await user.click(screen.getByRole("button", { name: "new login" }));
      await screen.findByText("authenticated");
      queryClient.setQueryData(["new-user"], "new-data");
      await act(async () => {
        if (outcome === "success")
          resolve({ status: "logged_out", end_session_url: "https://idp.example.test/logout" });
        else reject(new Error("remote unavailable"));
      });
      expect(tokenStore.getAccessToken()).toBe("new-access");
      expect(tokenStore.getRefreshToken()).toBe("new-refresh");
      expect(queryClient.getQueryData(["new-user"])).toBe("new-data");
      expect(screen.getByText("authenticated")).toBeVisible();
      expect(navigate).not.toHaveBeenCalled();
    },
  );

  it("ends local authentication and clears cached data before remote logout settles", async () => {
    const pending = deferredLogout();
    const queryClient = new QueryClient();
    tokenStore.saveTokens({ access_token: "old-access", refresh_token: "old-refresh" });
    mockApi({
      "GET /admin/ui-bootstrap": () => bootstrap,
      "POST /auth/keycloak/logout": () => pending.promise,
    });
    const published = vi.fn();
    const unsubscribe = subscribeToLogout(published);
    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <LogoutHarness />
          <AuthStateHarness />
        </AuthProvider>
      </QueryClientProvider>,
    );
    await screen.findByText("authenticated");
    queryClient.setQueryData(["private"], { secret: "old-session-data" });
    await userEvent.setup().click(screen.getByRole("button", { name: "logout" }));
    expect(tokenStore.getAccessToken()).toBe("");
    expect(tokenStore.getRefreshToken()).toBe("");
    expect(queryClient.getQueryData(["private"])).toBeUndefined();
    expect(screen.getByText("anonymous")).toBeVisible();
    expect(published).toHaveBeenCalledTimes(1);
    unsubscribe();
    await act(async () => pending.resolve());
  });

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

describe("AuthProvider telemetry opt-in", () => {
  const enabledBootstrap: UIBootstrap = {
    ...bootstrap,
    ui: { ...bootstrap.ui, telemetry_enabled: true },
    authentication: { ...bootstrap.authentication, keycloak_enabled: false },
  };

  it("defaults to disabled until an enabled authenticated bootstrap has resolved", async () => {
    const pending = deferredBootstrap();
    mockApi({ "GET /admin/ui-bootstrap": () => pending.promise });
    renderTelemetryAuth();
    expect(screen.getByTestId("telemetry-enabled")).toHaveTextContent("false");
    expect(screen.getByTestId("telemetry-auth-mode")).toHaveTextContent("loading");

    await act(async () => pending.resolve(enabledBootstrap));
    expect(screen.getByTestId("telemetry-enabled")).toHaveTextContent("true");
    expect(screen.getByTestId("telemetry-auth-mode")).toHaveTextContent("authenticated");
  });

  it.each(["combined", "fallback"])(
    "does not restore telemetry when a delayed initial %s bootstrap resolves after cross-tab logout",
    async (source) => {
      const pending = deferredBootstrap();
      const api = mockApi({
        "GET /admin/ui-bootstrap": () => {
          if (source === "combined") return pending.promise;
          throw new AppError("bootstrap unavailable", { kind: "http", status: 503 });
        },
        "GET /auth/sso-status": () => fallbackSsoStatus,
        "GET /auth/me": () =>
          pending.promise.then(() => ({
            auth_enabled: true,
            credential_prefixes: ["corp_"],
            user: bootstrap.user,
            version: "v0.86.1",
          })),
      });
      renderTelemetryAuth();
      if (source === "fallback") {
        await waitFor(() => expect(api.calls.some((call) => call.key === "GET /auth/me")).toBe(true));
      }
      act(() =>
        window.dispatchEvent(
          new StorageEvent("storage", { key: "vibe.app.auth.logout-event", newValue: "1" }),
        ),
      );
      expect(screen.getByTestId("telemetry-auth-mode")).toHaveTextContent("anonymous");
      await act(async () => pending.resolve(enabledBootstrap));
      expect(screen.getByTestId("telemetry-enabled")).toHaveTextContent("false");
      expect(screen.getByTestId("telemetry-auth-mode")).toHaveTextContent("anonymous");
    },
  );

  it.each([
    { name: "default disabled flag", data: bootstrap, mode: "authenticated", enabled: false },
    {
      name: "disabled console",
      data: { ...enabledBootstrap, ui: { ...enabledBootstrap.ui, enabled: false } },
      mode: "authenticated",
      enabled: false,
    },
    {
      name: "unverified session",
      data: {
        ...enabledBootstrap,
        authentication: { ...enabledBootstrap.authentication, authenticated: false },
        user: null,
      },
      mode: "anonymous",
      enabled: false,
    },
    {
      name: "unverified legacy token",
      data: {
        ...enabledBootstrap,
        authentication: {
          ...enabledBootstrap.authentication,
          authenticated: false,
          mode: "legacy_token" as const,
        },
        user: null,
      },
      mode: "anonymous",
      enabled: false,
    },
    {
      name: "verified legacy token",
      data: {
        ...enabledBootstrap,
        authentication: { ...enabledBootstrap.authentication, mode: "legacy_token" as const },
      },
      mode: "legacy",
      enabled: true,
    },
    {
      name: "server-confirmed open mode",
      data: {
        ...enabledBootstrap,
        authentication: {
          ...enabledBootstrap.authentication,
          enabled: false,
          authenticated: false,
          mode: "open" as const,
        },
      },
      mode: "open",
      enabled: true,
    },
  ])("resolves telemetry from $name", async ({ data, mode, enabled }) => {
    mockApi({ "GET /admin/ui-bootstrap": () => data });
    renderTelemetryAuth();
    await waitFor(() => expect(screen.getByTestId("telemetry-auth-mode")).toHaveTextContent(mode));
    expect(screen.getByTestId("telemetry-enabled")).toHaveTextContent(String(enabled));
  });

  it("clears an old opt-in during retry and leaves it off after authenticated fallback succeeds", async () => {
    const pending = deferredBootstrap();
    let bootstrapCalls = 0;
    mockApi({
      "GET /admin/ui-bootstrap": () => (++bootstrapCalls === 1 ? enabledBootstrap : pending.promise),
      "GET /auth/sso-status": () => fallbackSsoStatus,
      "GET /auth/me": () => ({
        auth_enabled: true,
        credential_prefixes: ["corp_"],
        user: bootstrap.user,
        version: "v0.86.1",
      }),
    });
    const user = userEvent.setup();
    renderTelemetryAuth();
    await waitFor(() => expect(screen.getByTestId("telemetry-enabled")).toHaveTextContent("true"));
    await user.click(screen.getByRole("button", { name: "telemetry retry" }));
    expect(screen.getByTestId("telemetry-enabled")).toHaveTextContent("false");
    expect(screen.getByTestId("telemetry-auth-mode")).toHaveTextContent("loading");
    await act(async () => pending.reject(new AppError("invalid bootstrap", { kind: "contract" })));
    await waitFor(() => expect(screen.getByTestId("telemetry-auth-mode")).toHaveTextContent("authenticated"));
    expect(screen.getByTestId("telemetry-enabled")).toHaveTextContent("false");
  });

  it.each([401, 503, "contract"] as const)(
    "fails closed on background bootstrap %s without discarding unrelated UI flags",
    async (failure) => {
      let bootstrapCalls = 0;
      const api = mockApi({
        "GET /admin/ui-bootstrap": () => {
          if (++bootstrapCalls === 1) return enabledBootstrap;
          throw new AppError("refresh failed", {
            kind: failure === "contract" ? "contract" : failure === 401 ? "auth" : "http",
            ...(failure === "contract" ? {} : { status: failure }),
          });
        },
      });
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      renderTelemetryAuth();
      await waitFor(() => expect(screen.getByTestId("telemetry-enabled")).toHaveTextContent("true"));
      act(() => document.dispatchEvent(new Event("visibilitychange")));
      await waitFor(() => expect(screen.getByTestId("telemetry-enabled")).toHaveTextContent("false"));
      expect(screen.getByTestId("telemetry-ui-enabled")).toHaveTextContent("true");
      expect(screen.getByTestId("telemetry-auth-mode")).toHaveTextContent(
        failure === 401 ? "anonymous" : "authenticated",
      );
      expect(api.calls.map((call) => call.key)).toEqual([
        "GET /admin/ui-bootstrap",
        "GET /admin/ui-bootstrap",
      ]);
    },
  );

  it("applies the current server opt-out on a successful background bootstrap", async () => {
    let current = enabledBootstrap;
    mockApi({ "GET /admin/ui-bootstrap": () => current });
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    renderTelemetryAuth();
    await waitFor(() => expect(screen.getByTestId("telemetry-enabled")).toHaveTextContent("true"));
    current = { ...enabledBootstrap, ui: { ...enabledBootstrap.ui, telemetry_enabled: false } };
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await waitFor(() => expect(screen.getByTestId("telemetry-enabled")).toHaveTextContent("false"));
    expect(screen.getByTestId("telemetry-auth-mode")).toHaveTextContent("authenticated");
  });

  it.each(["local", "cross-tab"])(
    "does not restore telemetry from a stale background response after %s logout",
    async (logout) => {
      const pending = deferredBootstrap();
      let bootstrapCalls = 0;
      mockApi({
        "GET /admin/ui-bootstrap": () => (++bootstrapCalls === 1 ? enabledBootstrap : pending.promise),
        "POST /auth/logout": () => ({}),
      });
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      const user = userEvent.setup();
      renderTelemetryAuth();
      await waitFor(() => expect(screen.getByTestId("telemetry-enabled")).toHaveTextContent("true"));
      act(() => document.dispatchEvent(new Event("visibilitychange")));
      expect(bootstrapCalls).toBe(2);
      if (logout === "local") {
        await user.click(screen.getByRole("button", { name: "telemetry logout" }));
      } else {
        act(() =>
          window.dispatchEvent(
            new StorageEvent("storage", { key: "vibe.app.auth.logout-event", newValue: "1" }),
          ),
        );
      }
      await waitFor(() => expect(screen.getByTestId("telemetry-auth-mode")).toHaveTextContent("anonymous"));
      expect(screen.getByTestId("telemetry-enabled")).toHaveTextContent("false");
      await act(async () => pending.resolve(enabledBootstrap));
      expect(screen.getByTestId("telemetry-enabled")).toHaveTextContent("false");
      expect(screen.getByTestId("telemetry-auth-mode")).toHaveTextContent("anonymous");
    },
  );

  it.each(["success", "failure"])(
    "deduplicates pending logout and blocks bootstrap until its %s",
    async (outcome) => {
      const older = deferredLogout();
      let logoutCalls = 0;
      const api = mockApi({
        "GET /admin/ui-bootstrap": () => enabledBootstrap,
        "POST /auth/logout": () => {
          logoutCalls += 1;
          return older.promise;
        },
      });
      tokenStore.saveTokens({ access_token: "access", refresh_token: "refresh" });
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      const user = userEvent.setup();
      renderTelemetryAuth();
      await waitFor(() => expect(screen.getByTestId("telemetry-enabled")).toHaveTextContent("true"));
      await user.click(screen.getByRole("button", { name: "telemetry logout" }));
      await user.click(screen.getByRole("button", { name: "telemetry logout" }));
      expect(logoutCalls).toBe(1);

      await act(async () => document.dispatchEvent(new Event("visibilitychange")));
      await user.click(screen.getByRole("button", { name: "telemetry retry" }));
      expect(api.calls.map((call) => call.key)).toEqual(["GET /admin/ui-bootstrap", "POST /auth/logout"]);
      expect(screen.getByTestId("telemetry-enabled")).toHaveTextContent("false");
      expect(screen.getByTestId("telemetry-auth-mode")).toHaveTextContent("anonymous");
      expect(tokenStore.getRefreshToken()).toBe("");

      await act(async () => {
        if (outcome === "success") older.resolve();
        else older.reject(new AppError("logout unavailable", { kind: "http", status: 503 }));
      });
      expect(screen.getByTestId("telemetry-enabled")).toHaveTextContent("false");
      expect(screen.getByTestId("telemetry-auth-mode")).toHaveTextContent("anonymous");
      expect(tokenStore.getRefreshToken()).toBe("");
    },
  );

  it.each(["success", "failure"])(
    "releases the pending logout guard on cross-tab logout before the old request's %s",
    async (outcome) => {
      const pending = deferredLogout();
      let current = enabledBootstrap;
      let bootstrapCalls = 0;
      mockApi({
        "GET /admin/ui-bootstrap": () => {
          bootstrapCalls += 1;
          return current;
        },
        "POST /auth/logout": () => pending.promise,
      });
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      const user = userEvent.setup();
      renderTelemetryAuth();
      await waitFor(() => expect(screen.getByTestId("telemetry-enabled")).toHaveTextContent("true"));
      await user.click(screen.getByRole("button", { name: "telemetry logout" }));
      current = {
        ...enabledBootstrap,
        authentication: { ...enabledBootstrap.authentication, authenticated: false },
        user: null,
      };
      act(() =>
        window.dispatchEvent(
          new StorageEvent("storage", { key: "vibe.app.auth.logout-event", newValue: "1" }),
        ),
      );
      expect(screen.getByTestId("telemetry-enabled")).toHaveTextContent("false");
      expect(screen.getByTestId("telemetry-auth-mode")).toHaveTextContent("anonymous");
      await act(async () => document.dispatchEvent(new Event("visibilitychange")));
      expect(bootstrapCalls).toBe(2);

      await act(async () => {
        if (outcome === "success") pending.resolve();
        else pending.reject(new AppError("logout unavailable", { kind: "http", status: 503 }));
      });
      await user.click(screen.getByRole("button", { name: "telemetry retry" }));
      expect(bootstrapCalls).toBe(3);
      expect(screen.getByTestId("telemetry-enabled")).toHaveTextContent("false");
      expect(screen.getByTestId("telemetry-auth-mode")).toHaveTextContent("anonymous");
    },
  );

  it("disables observation immediately during legacy token replacement and keeps it off on rejection", async () => {
    const pending = deferredBootstrap();
    let bootstrapCalls = 0;
    mockApi({
      "GET /admin/ui-bootstrap": () => (++bootstrapCalls === 1 ? enabledBootstrap : pending.promise),
    });
    const user = userEvent.setup();
    renderTelemetryAuth();
    await waitFor(() => expect(screen.getByTestId("telemetry-enabled")).toHaveTextContent("true"));
    await user.click(screen.getByRole("button", { name: "replace telemetry token" }));
    expect(screen.getByTestId("telemetry-enabled")).toHaveTextContent("false");
    await act(async () => pending.reject(new AppError("invalid token", { kind: "auth", status: 401 })));
    expect(screen.getByTestId("telemetry-enabled")).toHaveTextContent("false");
    expect(tokenStore.getLegacyToken()).toBe("");
  });

  it("does not let an old background 401 disable the newly verified legacy session", async () => {
    const pending = deferredBootstrap();
    let bootstrapCalls = 0;
    mockApi({
      "GET /admin/ui-bootstrap": () => {
        bootstrapCalls += 1;
        if (bootstrapCalls === 1) return enabledBootstrap;
        if (bootstrapCalls === 2) return pending.promise;
        return {
          ...enabledBootstrap,
          authentication: { ...enabledBootstrap.authentication, mode: "legacy_token" },
        };
      },
    });
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    const user = userEvent.setup();
    renderTelemetryAuth();
    await waitFor(() => expect(screen.getByTestId("telemetry-enabled")).toHaveTextContent("true"));
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await user.click(screen.getByRole("button", { name: "replace telemetry token" }));
    await waitFor(() => expect(screen.getByTestId("telemetry-auth-mode")).toHaveTextContent("legacy"));
    expect(screen.getByTestId("telemetry-enabled")).toHaveTextContent("true");
    await act(async () => pending.reject(new AppError("old credentials", { kind: "auth", status: 401 })));
    expect(screen.getByTestId("telemetry-enabled")).toHaveTextContent("true");
    expect(screen.getByTestId("telemetry-auth-mode")).toHaveTextContent("legacy");
    expect(tokenStore.getLegacyToken()).toBe("replacement-token");
  });
});
