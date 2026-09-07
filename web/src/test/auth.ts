import type { AuthContextValue } from "@/app/auth/AuthProvider";
import { migrationRegistry } from "@/config/migration-registry";
import type { AuthUser } from "@/shared/api/schemas";

const adminScopes = [
  "chat:completion",
  "embeddings:create",
  "models:read",
  "admin:read",
  "admin:write",
  "routing:read",
  "routing:write",
  "observability:read",
  "costs:read",
  "security:read",
  "mcp:use",
  "mcp:admin",
  "team:read",
];

export interface TestAuthOptions {
  role?: string;
  scopes?: readonly string[];
  legacyFallback?: boolean;
  backendVersion?: string;
  user?: Partial<AuthUser>;
}

/**
 * Auth context for screen tests. Use inside a hoisted `vi.mock` factory:
 *
 *   vi.mock("@/app/auth/AuthProvider", async () => {
 *     const { testAuth } = await import("@/test/auth");
 *     return { useAuth: () => testAuth({ scopes: ["admin:read"] }) };
 *   });
 */
export function testAuth(options: TestAuthOptions = {}): AuthContextValue {
  const role = options.role ?? "admin";
  const user: AuthUser = {
    id: "usr_test",
    email: "operator@example.com",
    name: "운영자",
    role,
    roles: [role],
    team_id: "",
    scopes: [...(options.scopes ?? adminScopes)],
    features: {},
    ...options.user,
  };
  return {
    mode: "authenticated",
    user,
    backendVersion: options.backendVersion ?? "v9.9.9",
    uiVersion: "test",
    apiVersion: "v1",
    sso: { keycloak_enabled: false, allow_local_login: true, login_url: "/auth/keycloak/login" },
    authenticationMode: "session",
    uiEnabled: true,
    defaultEntry: "/app/overview",
    legacyFallback: options.legacyFallback ?? true,
    credentialPrefixes: ["vc_sk_", "vc_sa_"],
    features: migrationRegistry,
    login: async () => undefined,
    logout: async () => undefined,
    retry: async () => undefined,
    setLegacyToken: async () => undefined,
  };
}
