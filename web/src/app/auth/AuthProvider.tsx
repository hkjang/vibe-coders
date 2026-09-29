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
import {
  beginSilentSso,
  clearSilentSsoState,
  markSignedOut,
  shouldAttemptSilentSso,
} from "@/shared/auth/silent-sso";
import { consumeSsoReturnTo, safeReturnTo, stageSsoReturnTo } from "@/shared/utils/safe-return-to";
import { migrationRegistry, registryFromBootstrap, type MigrationFeature } from "@/config/migration-registry";
import type { UICapabilities } from "@/shared/api/schemas";
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
  telemetryEnabled: boolean;
  credentialPrefixes: readonly string[];
  capabilities: UICapabilities;
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
  auto_login: false,
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
  const [telemetryEnabled, setTelemetryEnabled] = useState(false);
  const [credentialPrefixes, setCredentialPrefixes] = useState<readonly string[]>([
    ...defaultCredentialPrefixes,
  ]);
  const [capabilities, setCapabilities] = useState<UICapabilities>({ raw_prompt_view: false });
  const [features, setFeatures] = useState<readonly MigrationFeature[]>(migrationRegistry);
  const [error, setError] = useState<string>();
  const started = useRef(false);
  // True when this page load is the landing of an SSO callback (a code or an error came
  // back in the fragment). A silent attempt must not start from that landing.
  const ssoCallbackLanding = useRef(false);
  const runtimeRefreshFlight = useRef<Promise<void> | undefined>(undefined);
  const authEpoch = useRef(0);
  const signingOut = useRef(false);
  const logoutFlight = useRef<{ sessionEpoch: number; promise: Promise<void> } | undefined>(undefined);

  const applyBootstrap = useCallback((data: UIBootstrap): void => {
    setBackendVersion(data.backend_version);
    setUiVersion(data.ui_version);
    setApiVersion(data.api_version);
    setUiEnabled(data.ui.enabled);
    setDefaultEntry(data.ui.default_entry);
    setLegacyFallback(data.ui.legacy_fallback);
    setTelemetryEnabled(
      data.ui.enabled &&
        data.ui.telemetry_enabled &&
        (data.authentication.authenticated || data.authentication.mode === "open"),
    );
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
      auto_login: data.authentication.auto_login ?? false,
    });
    setCapabilities(data.capabilities);
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

  const fallbackBootstrap = useCallback(async (epoch: number): Promise<void> => {
    if (epoch !== authEpoch.current) return;
    setTelemetryEnabled(false);
    const ssoRequest = apiClient
      .request(endpoints.auth.ssoStatus, { retryUnauthorized: false })
      .then((status) => {
        if (epoch === authEpoch.current) setSso(status);
      })
      .catch(() => {
        if (epoch === authEpoch.current) setSso(defaultSso);
      });
    const me = await apiClient.request(endpoints.auth.me, {
      routeId: "auth.bootstrap.fallback",
    });
    if (epoch !== authEpoch.current) return;
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
    if (signingOut.current) return;
    const epoch = ++authEpoch.current;
    runtimeRefreshFlight.current = undefined;
    setTelemetryEnabled(false);
    setMode("loading");
    setError(undefined);

    try {
      const data = await apiClient.request(endpoints.uiBootstrap, {
        routeId: "auth.bootstrap",
      });
      if (epoch === authEpoch.current) applyBootstrap(data);
    } catch (bootstrapError) {
      if (epoch !== authEpoch.current) return;
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
          if (epoch !== authEpoch.current) return;
          applyBootstrap(anonymousBootstrap);
        } catch {
          if (epoch !== authEpoch.current) return;
          try {
            const status = await apiClient.request(endpoints.auth.ssoStatus, {
              retryUnauthorized: false,
              routeId: "auth.bootstrap.sso-status",
            });
            if (epoch !== authEpoch.current) return;
            setSso(status);
          } catch {
            if (epoch !== authEpoch.current) return;
            setSso(defaultSso);
          }
          setMode("anonymous");
        }
        setError("인증 정보가 올바르지 않거나 만료되었습니다.");
        return;
      }
      try {
        await fallbackBootstrap(epoch);
      } catch (fallbackError) {
        if (epoch !== authEpoch.current) return;
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
    if (signingOut.current) return Promise.resolve();
    if (runtimeRefreshFlight.current) return runtimeRefreshFlight.current;
    const epoch = authEpoch.current;
    const request = apiClient
      .request(endpoints.uiBootstrap, {
        routeId: "auth.bootstrap.visibility",
      })
      .then((data) => {
        if (epoch === authEpoch.current) applyBootstrap(data);
      })
      .catch((refreshError: unknown) => {
        if (epoch !== authEpoch.current) return;
        // Opt-in observation fails closed, unlike last-known-good navigation.
        setTelemetryEnabled(false);
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
      const epoch = authEpoch.current;
      let ssoErrorCode = fragment.error;
      if (fragment.code) {
        tokenStore.clearTokens();
        try {
          const tokens = await apiClient.request(endpoints.auth.ssoExchange, {
            body: { code: fragment.code },
            retryUnauthorized: false,
            routeId: "auth.sso.exchange",
          });
          if (epoch !== authEpoch.current) return;
          tokenStore.saveTokens(tokens);
        } catch (exchangeError) {
          if (epoch !== authEpoch.current) return;
          ssoErrorCode = normalizeSsoFailureCode(
            isAppError(exchangeError) ? exchangeError.code : undefined,
            "sso_exchange_failed",
          );
        }
      }
      await bootstrap();
      if (ssoErrorCode && authEpoch.current === epoch + 1) setError(formatSsoFailure(ssoErrorCode));
    },
    [bootstrap],
  );

  useLayoutEffect(() => {
    if (started.current) return;
    started.current = true;
    const fragment = captureSsoFragment();
    ssoCallbackLanding.current = Boolean(fragment.code || fragment.error);
    void completeSsoBootstrap(fragment);
  }, [completeSsoBootstrap]);

  // Silent SSO: a visitor with a live Keycloak session is signed in without seeing the
  // login screen. The rule module guarantees at most one attempt per tab session, none
  // after a deliberate sign-out, and none once the callback has answered with ?sso=none.
  useEffect(() => {
    if (mode === "authenticated") {
      clearSilentSsoState();
      return;
    }
    if (mode !== "anonymous" || authenticationMode !== "session" || ssoCallbackLanding.current) return;
    if (!shouldAttemptSilentSso(sso)) return;
    const { pathname, search, hash } = window.location;
    beginSilentSso(sso.login_url, stageSsoReturnTo(safeReturnTo(`${pathname}${search}${hash}`)));
  }, [authenticationMode, mode, sso]);

  useEffect(
    () =>
      subscribeToLogout(() => {
        authEpoch.current += 1;
        signingOut.current = false;
        runtimeRefreshFlight.current = undefined;
        setTelemetryEnabled(false);
        markSignedOut();
        queryClient.clear();
        setUser(undefined);
        setExpiresAt(undefined);
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
      const epoch = ++authEpoch.current;
      signingOut.current = false;
      setTelemetryEnabled(false);
      tokenStore.clearAll();
      queryClient.clear();
      setUser(undefined);
      setExpiresAt(undefined);
      setMode("anonymous");
      const tokens = await apiClient.request(endpoints.auth.login, {
        body: { email, password },
        retryUnauthorized: false,
        routeId: "auth.login",
      });
      if (epoch !== authEpoch.current) return;
      tokenStore.saveTokens(tokens);
      queryClient.clear();
      await bootstrap();
    },
    [bootstrap, queryClient],
  );

  const logout = useCallback((): Promise<void> => {
    if (logoutFlight.current?.sessionEpoch === tokenStore.getSessionEpoch()) {
      return logoutFlight.current.promise;
    }
    // Keep only this revocation request's credentials, not the live browser session.
    const refreshToken = tokenStore.getRefreshToken();
    const accessToken = tokenStore.getAccessToken() || tokenStore.getLegacyToken();
    authEpoch.current += 1;
    runtimeRefreshFlight.current = undefined;
    setTelemetryEnabled(false);
    // Security boundary is synchronous; network latency must not retain authority
    // in this tab, cached data, or another tab. Silent SSO must stay signed out.
    markSignedOut();
    queryClient.clear();
    setUser(undefined);
    setExpiresAt(undefined);
    setMode(authenticationMode === "open" ? "open" : "anonymous");
    publishLogout();
    // Same-tab logout listeners ran synchronously above. Protect against runtime
    // bootstrap until this flight ends, but allow a deliberate new login to win.
    const epoch = authEpoch.current;
    const sessionEpoch = tokenStore.getSessionEpoch();
    signingOut.current = true;
    const headers = accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined;
    const promise = (async (): Promise<void> => {
      let endSessionUrl: string | undefined;
      try {
        if (sso.keycloak_enabled) {
          const response = await apiClient.request(endpoints.auth.keycloakLogout, {
            body: { refresh_token: refreshToken, return_to: "/app/login" },
            headers,
            retryUnauthorized: false,
            routeId: "auth.keycloak.logout",
          });
          endSessionUrl = safeEndSessionUrl(response.end_session_url);
        } else {
          await apiClient.request(endpoints.auth.logout, {
            body: { refresh_token: refreshToken },
            headers,
            retryUnauthorized: false,
            routeId: "auth.logout",
          });
        }
      } catch {
        // Local logout already completed even if revocation is unavailable.
      }
      if (epoch !== authEpoch.current || sessionEpoch !== tokenStore.getSessionEpoch()) return;
      signingOut.current = false;
      if (endSessionUrl) authNavigation.toEndSession(endSessionUrl);
    })().finally(() => {
      if (logoutFlight.current?.promise === promise) logoutFlight.current = undefined;
    });
    logoutFlight.current = { sessionEpoch, promise };
    return promise;
  }, [authenticationMode, queryClient, sso.keycloak_enabled]);

  const setLegacyToken = useCallback(
    async (token: string): Promise<void> => {
      const epoch = ++authEpoch.current;
      signingOut.current = false;
      runtimeRefreshFlight.current = undefined;
      setTelemetryEnabled(false);
      queryClient.clear();
      setUser(undefined);
      setExpiresAt(undefined);
      setMode("anonymous");
      tokenStore.setLegacyToken(token);
      try {
        const data = await apiClient.request(endpoints.uiBootstrap, {
          retryUnauthorized: false,
          routeId: "auth.legacy-token",
        });
        if (data.authentication.mode !== "legacy_token" || !data.authentication.authenticated) {
          throw new AppError("기존 관리자 토큰이 올바르지 않습니다.", { kind: "auth", status: 401 });
        }
        if (epoch === authEpoch.current) applyBootstrap(data);
      } catch (error) {
        if (epoch === authEpoch.current) {
          setTelemetryEnabled(false);
          tokenStore.clearAll();
        }
        throw error;
      }
    },
    [applyBootstrap, queryClient],
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
      telemetryEnabled,
      credentialPrefixes,
      capabilities,
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
      capabilities,
      credentialPrefixes,
      defaultEntry,
      error,
      expiresAt,
      features,
      legacyFallback,
      telemetryEnabled,
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
