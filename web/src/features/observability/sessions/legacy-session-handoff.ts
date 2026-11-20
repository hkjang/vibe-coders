import { useAuth } from "@/app/auth/AuthProvider";
import { isLegacyAdminHref, legacyRoutes } from "@/config/legacy-route-map";
import { containsPotentialSecret } from "@/shared/security/secrets";

// Match the existing path lookup without its legacy TrimSpace aliasing. The
// display session_id in a response may be masked and is never a lookup target.
export function validSessionHandoffID(id: string, prefixes: readonly string[]): boolean {
  return (
    id !== "" &&
    id !== "." &&
    id !== ".." &&
    id.trim() === id &&
    new TextEncoder().encode(id).length <= 4096 &&
    !/[\\/\p{C}]/u.test(id) &&
    !containsPotentialSecret(id, prefixes)
  );
}
export function selectedSessionID(params: URLSearchParams, prefixes: readonly string[]): string {
  const values = params.getAll("session_id");
  const id = values[0] ?? "";
  return values.length === 1 && validSessionHandoffID(id, prefixes) ? id : "";
}
export function sessionLegacyHandoff(
  base: string | undefined,
  id: string,
  supported: boolean,
  prefixes: readonly string[],
): { href?: `/admin${string}`; sameSession: boolean } {
  if (!isLegacyAdminHref(base) || containsPotentialSecret(base, prefixes)) return { sameSession: false };
  const fallback = { href: base, sameSession: false };
  if (base !== legacyRoutes.sessions || !supported || !validSessionHandoffID(id, prefixes)) return fallback;
  const href = `${base}?${new URLSearchParams({ session_id: id })}`;
  return href.length <= 16384 && isLegacyAdminHref(href) ? { href, sameSession: true } : fallback;
}
export function useSessionLegacyHandoff(id: string) {
  const auth = useAuth();
  return sessionLegacyHandoff(
    auth.features.find((feature) => feature.featureId === "observability.sessions")?.legacyPath,
    id,
    auth.capabilities?.legacy_session_detail === true,
    auth.credentialPrefixes,
  );
}
