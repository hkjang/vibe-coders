import type { AuthUser } from "@/shared/api/schemas";

interface LegacyAdminAccess {
  authenticationMode?: string;
  legacyFallback: boolean;
  mode: string;
  user?: Pick<AuthUser, "scopes">;
}

export function canOpenLegacyAdmin({
  authenticationMode,
  legacyFallback,
  mode,
  user,
}: LegacyAdminAccess): boolean {
  if (!legacyFallback) return false;
  if (mode === "legacy" || mode === "open" || authenticationMode === "legacy_token") return true;
  return user?.scopes.includes("admin:read") ?? false;
}
