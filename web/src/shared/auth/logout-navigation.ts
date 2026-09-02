export function safeEndSessionUrl(raw: string, origin = window.location.origin): string | undefined {
  if (!raw.trim()) return undefined;
  try {
    const url = new URL(raw, origin);
    if (url.username || url.password) return undefined;
    if (url.origin === origin && (url.protocol === "http:" || url.protocol === "https:"))
      return url.toString();
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export const authNavigation = {
  toEndSession(url: string): void {
    window.location.assign(url);
  },
};
