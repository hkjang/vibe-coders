const appBase = "/app";
const ssoReturnKey = "vibe.app.auth.sso-return-to";

export function safeReturnTo(raw: string | null | undefined, fallback = "/overview"): string {
  const candidate = raw?.trim();
  if (!candidate || candidate.includes("\\") || candidate.startsWith("//")) return fallback;

  try {
    const parsed = new URL(candidate, window.location.origin);
    if (parsed.origin !== window.location.origin) return fallback;
    if (parsed.pathname !== appBase && !parsed.pathname.startsWith(`${appBase}/`)) return fallback;
    const relativePath = parsed.pathname.slice(appBase.length) || "/";
    return `${relativePath}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}

export function appReturnTo(pathname: string, search = "", hash = ""): string {
  const safePath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${appBase}${safePath}${search}${hash}`;
}

export function stageSsoReturnTo(routerPath: string): string {
  const relative = safeReturnTo(`${appBase}${routerPath}`, "/overview");
  const fullPath = `${appBase}${relative}`;
  try {
    window.sessionStorage.setItem(ssoReturnKey, fullPath);
  } catch {
    // The server still restores pathname and query when session storage is unavailable.
  }
  const parsed = new URL(fullPath, window.location.origin);
  return `${parsed.pathname}${parsed.search}`;
}

export function consumeSsoReturnTo(): string | undefined {
  let stored: string;
  try {
    stored = window.sessionStorage.getItem(ssoReturnKey) ?? "";
    window.sessionStorage.removeItem(ssoReturnKey);
  } catch {
    return undefined;
  }
  if (!stored) return undefined;
  const relative = safeReturnTo(stored, "");
  return relative ? `${appBase}${relative}` : undefined;
}
