import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";
import { AppError, isAppError } from "@/shared/api/error";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { type AuthUser, type SsoStatus, type UIBootstrap } from "@/shared/api/schemas";
import { publishLogout, subscribeToLogout, tokenStore } from "@/shared/auth/token-store";
import { authNavigation, safeEndSessionUrl } from "@/shared/auth/logout-navigation";
import { consumeSsoReturnTo } from "@/shared/utils/safe-return-to";
import { migrationRegistry, registryFromBootstrap, type MigrationFeature } from "@/config/migration-registry";
import { formatSsoFailure, normalizeSsoFailureCode } from "@/app/auth/sso-errors";
import { defaultCredentialPrefixes } from "@/shared/security/secrets";

export type AuthMode = "anonymous" | "authenticated" | "error" | "legacy" | "loading" | "open";
export type AuthenticationMode = "legacy_token" | "open" | "session";

export interface AuthContextValue {
  mode: AuthMode;
  user?: AuthUser;
  backendVersion: string;
  uiVersion: string;
  apiVersion: string;
  expiresAt?: number;
  sso: SsoStatus;
  authenticationMode: AuthenticationMode;
  uiEnabled: boolean;
  defaultEntry: string;
  legacyFallback: boolean;
  credentialPrefixes: readonly string[];
  features: readonly MigrationFeature[];
  error?: string;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  retry: () => Promise<void>;
  setLegacyToken: (token: string) => Promise<void>;
}

const defaultSso: SsoStatus = {
  keycloak_enabled: false,
  allow_local_login: true,
  login_url: endpoints.auth.keycloakLogin.path,
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

interface SsoFragment {
  code?: string;
  error?: string;
}

function captureSsoFragment(): SsoFragment {
  const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const code = fragment.get("kc_code")?.trim();
  const error = fragment.get("kc_error");
  const obsoleteTokenFragment = fragment.has("kc_access") || fragment.has("kc_refresh");
  if (code || error || obsoleteTokenFragment) {
    const pendingReturn = consumeSsoReturnTo();
    window.history.replaceState(
      null,
      "",
      pendingReturn ?? `${window.location.pathname}${window.location.search}`,
    );
  }
  return {
    code: code || undefined,
    error: error ?? (obsoleteTokenFragment ? "unsupported_sso_callback" : undefined),
  };
}

export function AuthProvider({ children }: PropsWithChildren): React.JSX.Element {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<AuthMode>("loading");
  const [user, setUser] = useState<AuthUser>();
  const [backendVersion, setBackendVersion] = useState("확인 불가");
  const [uiVersion, setUiVersion] = useState(__UI_VERSION__);
  const [apiVersion, setApiVersion] = useState("확인 불가");
  const [expiresAt, setExpiresAt] = useState<number>();
  const [sso, setSso] = useState<SsoStatus>(defaultSso);
  const [authenticationMode, setAuthenticationMode] = useState<AuthenticationMode>("session");
  const [uiEnabled, setUiEnabled] = useState(true);
  const [defaultEntry, setDefaultEntry] = useState("/app/overview");
  const [legacyFallback, setLegacyFallback] = useState(true);
  const [credentialPrefixes, setCredentialPrefixes] = useState<readonly string[]>([
    ...defaultCredentialPrefixes,
  ]);
  const [features, setFeatures] = useState<readonly MigrationFeature[]>(migrationRegistry);
  const [error, setError] = useState<string>();
  const started = useRef(false);
  const runtimeRefreshFlight = useRef<Promise<void> | undefined>(undefined);

  const applyBootstrap = useCallback((data: UIBootstrap): void => {
    setBackendVersion(data.backend_version);
    setUiVersion(data.ui_version);
    setApiVersion(data.api_version);
    setUiEnabled(data.ui.enabled);
    setDefaultEntry(data.ui.default_entry);
    setLegacyFallback(data.ui.legacy_fallback);
    setCredentialPrefixes(
      data.authentication.credential_prefixes?.length
        ? [...data.authentication.credential_prefixes]
        : [...defaultCredentialPrefixes],
    );
    setAuthenticationMode(data.authentication.mode);
    setSso({
      keycloak_enabled: data.authentication.keycloak_enabled,
      allow_local_login: data.authentication.allow_local_login,
      login_url: data.authentication.sso_login_url,
    });
    setFeatures(registryFromBootstrap(data.migration_registry));
    setUser(data.user ?? undefined);

    if (data.authentication.mode === "open") {
      setMode("open");
    } else if (!data.authentication.authenticated) {
      setMode("anonymous");
    } else if (data.authentication.mode === "legacy_token") {
      setMode("legacy");
    } else {
      setMode("authenticated");
    }
  }, []);

  const fallbackBootstrap = useCallback(async (): Promise<void> => {
    const ssoRequest = apiClient
      .request(endpoints.auth.ssoStatus, { retryUnauthorized: false })
      .then(setSso)
      .catch(() => setSso(defaultSso));
    const me = await apiClient.request(endpoints.auth.me, {
      routeId: "auth.bootstrap.fallback",
    });
    if (!me.credential_prefixes?.length) {
      throw new Error("credential prefix configuration unavailable");
    }
    setBackendVersion(me.version);
    setCredentialPrefixes([...me.credential_prefixes]);
    setExpiresAt(me.expires_at);
    setFeatures(migrationRegistry);
    if (!me.auth_enabled) {
      setAuthenticationMode("legacy_token");
      setUser(undefined);
      setMode(tokenStore.getLegacyToken() ? "legacy" : "anonymous");
    } else if (me.user) {
      setAuthenticationMode("session");
      setUser(me.user);
      setMode("authenticated");
    } else {
      setAuthenticationMode("session");
      setUser(undefined);
      setMode("anonymous");
    }
    await ssoRequest;
  }, []);

  const bootstrap = useCallback(async (): Promise<void> => {
    setMode("loading");
    setError(undefined);

    try {
      const data = await apiClient.request(endpoints.uiBootstrap, {
        routeId: "auth.bootstrap",
      });
      applyBootstrap(data);
    } catch (bootstrapError) {
      if (isAppError(bootstrapError) && bootstrapError.status === 401) {
        tokenStore.clearAll();
        queryClient.clear();
        setUser(undefined);
        setExpiresAt(undefined);
        try {
          const anonymousBootstrap = await apiClient.request(endpoints.uiBootstrap, {
            retryUnauthorized: false,
            routeId: "auth.bootstrap.anonymous",
          });
          applyBootstrap(anonymousBootstrap);
        } catch {
          try {
            const status = await apiClient.request(endpoints.auth.ssoStatus, {
              retryUnauthorized: false,
              routeId: "auth.bootstrap.sso-status",
            });
            setSso(status);
          } catch {
            setSso(defaultSso);
          }
          setMode("anonymous");
        }
        setError("인증 정보가 올바르지 않거나 만료되었습니다.");
        return;
      }
      try {
        await fallbackBootstrap();
      } catch (fallbackError) {
        if (isAppError(fallbackError) && fallbackError.status === 401) {
          tokenStore.clearTokens();
          setUser(undefined);
          setMode("anonymous");
        } else {
          setMode("error");
          setError("인증 상태를 확인할 수 없습니다.");
        }
      }
    }
  }, [applyBootstrap, fallbackBootstrap, queryClient]);

  const refreshRuntimeConfig = useCallback((): Promise<void> => {
    if (runtimeRefreshFlight.current) return runtimeRefreshFlight.current;
    const request = apiClient
      .request(endpoints.uiBootstrap, {
        routeId: "auth.bootstrap.visibility",
      })
      .then(applyBootstrap)
      .catch((refreshError: unknown) => {
        if (isAppError(refreshError) && refreshError.status === 401) {
          tokenStore.clearAll();
          queryClient.clear();
          setUser(undefined);
          setMode("anonymous");
        }
        // A transient background refresh failure keeps the last-known-good UI
        // state. The normal retry surface remains available on a full reload.
      });
    const flight = request.finally(() => {
      if (runtimeRefreshFlight.current === flight) runtimeRefreshFlight.current = undefined;
    });
    runtimeRefreshFlight.current = flight;
    return flight;
  }, [applyBootstrap, queryClient]);

  const completeSsoBootstrap = useCallback(
    async (fragment: SsoFragment): Promise<void> => {
      let ssoErrorCode = fragment.error;
      if (fragment.code) {
        tokenStore.clearTokens();
        try {
          const tokens = await apiClient.request(endpoints.auth.ssoExchange, {
            body: { code: fragment.code },
            retryUnauthorized: false,
            routeId: "auth.sso.exchange",
          });
          tokenStore.saveTokens(tokens);
        } catch (exchangeError) {
          ssoErrorCode = normalizeSsoFailureCode(
            isAppError(exchangeError) ? exchangeError.code : undefined,
            "sso_exchange_failed",
          );
        }
      }
      await bootstrap();
      if (ssoErrorCode) setError(formatSsoFailure(ssoErrorCode));
    },
    [bootstrap],
  );

  useLayoutEffect(() => {
    if (started.current) return;
    started.current = true;
    const fragment = captureSsoFragment();
    void completeSsoBootstrap(fragment);
  }, [completeSsoBootstrap]);

  useEffect(
    () =>
      subscribeToLogout(() => {
        tokenStore.clearAll();
        queryClient.clear();
        setUser(undefined);
        setMode(authenticationMode === "open" ? "open" : "anonymous");
      }),
    [authenticationMode, queryClient],
  );

  useEffect(() => {
    const refreshWhenVisible = (): void => {
      if (document.visibilityState === "visible" && mode !== "loading") void refreshRuntimeConfig();
    };
    document.addEventListener("visibilitychange", refreshWhenVisible);
    const interval = window.setInterval(refreshWhenVisible, 60_000);
    return () => {
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      window.clearInterval(interval);
    };
  }, [mode, refreshRuntimeConfig]);

  const login = useCallback(
    async (email: string, password: string): Promise<void> => {
      const tokens = await apiClient.request(endpoints.auth.login, {
        body: { email, password },
        retryUnauthorized: false,
        routeId: "auth.login",
      });
      tokenStore.saveTokens(tokens);
      queryClient.clear();
      await bootstrap();
    },
    [bootstrap, queryClient],
  );

  const logout = useCallback(async (): Promise<void> => {
    const refreshToken = tokenStore.getRefreshToken();
    let endSessionUrl: string | undefined;
    try {
      if (sso.keycloak_enabled) {
        const response = await apiClient.request(endpoints.auth.keycloakLogout, {
          body: { refresh_token: refreshToken, return_to: "/app/login" },
          retryUnauthorized: false,
          routeId: "auth.keycloak.logout",
        });
        endSessionUrl = safeEndSessionUrl(response.end_session_url);
      } else {
        await apiClient.request(endpoints.auth.logout, {
          body: { refresh_token: refreshToken },
          retryUnauthorized: false,
          routeId: "auth.logout",
        });
      }
    } catch {
      // Local logout must complete even if the gateway is unavailable.
    }
    tokenStore.clearAll();
    queryClient.clear();
    setUser(undefined);
    setMode(authenticationMode === "open" ? "open" : "anonymous");
    publishLogout();
    if (endSessionUrl) authNavigation.toEndSession(endSessionUrl);
  }, [authenticationMode, queryClient, sso.keycloak_enabled]);

  const setLegacyToken = useCallback(
    async (token: string): Promise<void> => {
      tokenStore.setLegacyToken(token);
      try {
        const data = await apiClient.request(endpoints.uiBootstrap, {
          retryUnauthorized: false,
          routeId: "auth.legacy-token",
        });
        if (data.authentication.mode !== "legacy_token" || !data.authentication.authenticated) {
          throw new AppError("기존 관리자 토큰이 올바르지 않습니다.", { kind: "auth", status: 401 });
        }
        applyBootstrap(data);
      } catch (error) {
        tokenStore.clearAll();
        throw error;
      }
    },
    [applyBootstrap],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      mode,
      user,
      backendVersion,
      uiVersion,
      apiVersion,
      expiresAt,
      sso,
      authenticationMode,
      uiEnabled,
      defaultEntry,
      legacyFallback,
      credentialPrefixes,
      features,
      error,
      login,
      logout,
      retry: bootstrap,
      setLegacyToken,
    }),
    [
      apiVersion,
      authenticationMode,
      backendVersion,
      bootstrap,
      credentialPrefixes,
      defaultEntry,
      error,
      expiresAt,
      features,
      legacyFallback,
      login,
      logout,
      mode,
      setLegacyToken,
      sso,
      uiEnabled,
      uiVersion,
      user,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider");
  return context;
}
