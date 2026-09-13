import type { SsoStatus } from "@/shared/api/schemas";

// sessionStorage rather than localStorage: a silent attempt is scoped to this tab's
// browsing session, so a fresh tab tries again while a reload after a refusal does not.
const attemptedKey = "vibe.app.auth.sso-silent-attempted";
const signedOutKey = "vibe.app.auth.sso-signed-out";

// The console's own login route and the gateway's browser auth endpoints. A silent attempt
// started from either is the most common source of a redirect loop.
const excludedPathPrefixes = ["/app/login", "/auth/"];

function readFlag(key: string): boolean {
  try {
    return window.sessionStorage.getItem(key) === "true";
  } catch {
    // Private modes and blocked site data throw. Reading that as "not yet attempted"
    // would retry on every load, so the failure mode is "already attempted".
    return true;
  }
}

function writeFlag(key: string, value: boolean): void {
  try {
    if (value) window.sessionStorage.setItem(key, "true");
    else window.sessionStorage.removeItem(key);
  } catch {
    // readFlag already fails closed when storage is unavailable.
  }
}

/** Records a deliberate sign-out so the next visit is not signed back in silently. */
export function markSignedOut(): void {
  writeFlag(signedOutKey, true);
  writeFlag(attemptedKey, true);
}

/** Lifts the suppression once a session exists again. */
export function clearSilentSsoState(): void {
  writeFlag(signedOutKey, false);
  writeFlag(attemptedKey, false);
}

export interface SilentSsoLocation {
  pathname: string;
  search: string;
}

/**
 * Decides whether to try signing in without showing the login screen.
 *
 * prompt=none either answers with a code at once or comes back as login_required, so the
 * attempt must happen at most once per browsing session; retrying on every page load
 * would bounce the browser between the provider and the console indefinitely.
 */
export function shouldAttemptSilentSso(
  sso: Pick<SsoStatus, "keycloak_enabled" | "auto_login">,
  location: SilentSsoLocation = window.location,
): boolean {
  if (!sso.keycloak_enabled || !sso.auto_login) return false;
  if (excludedPathPrefixes.some((prefix) => location.pathname.startsWith(prefix))) return false;
  // The callback appends this marker when the provider had no session, so a refusal is
  // remembered even when sessionStorage was cleared in between.
  const marker = new URLSearchParams(location.search).get("sso");
  if (marker === "none" || marker === "error") return false;
  if (readFlag(signedOutKey)) return false;
  if (readFlag(attemptedKey)) return false;
  return true;
}

export const silentSsoNavigation = {
  toProvider(url: string): void {
    window.location.assign(url);
  },
};

/** Sends the browser to the gateway login leg with prompt=none as a top-level navigation. */
export function beginSilentSso(loginUrl: string, returnTo: string): void {
  writeFlag(attemptedKey, true);
  const target = new URL(loginUrl, window.location.origin);
  target.searchParams.set("prompt", "none");
  target.searchParams.set("return_to", returnTo);
  silentSsoNavigation.toProvider(target.toString());
}
