import type { TokenPair } from "@/shared/api/schemas";

const keys = {
  access: "vibe.app.auth.access",
  refresh: "vibe.app.auth.refresh",
  legacy: "vibe.app.auth.legacy-admin",
  logoutEvent: "vibe.app.auth.logout-event",
} as const;

const channelName = "vibe-app-auth";
const localLogoutEvent = "vibe:logout";

function read(key: string): string {
  try {
    return window.sessionStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function write(key: string, value: string): void {
  try {
    if (value) window.sessionStorage.setItem(key, value);
    else window.sessionStorage.removeItem(key);
  } catch {
    // Storage may be disabled by browser policy. In-memory login still works until reload.
  }
}

let memoryAccess = typeof window === "undefined" ? "" : read(keys.access);
let memoryRefresh = typeof window === "undefined" ? "" : read(keys.refresh);
let memoryLegacy = typeof window === "undefined" ? "" : read(keys.legacy);

export const tokenStore = {
  getAccessToken: (): string => memoryAccess,
  getRefreshToken: (): string => memoryRefresh,
  getLegacyToken: (): string => memoryLegacy,
  saveTokens: (tokens: Pick<TokenPair, "access_token" | "refresh_token">): void => {
    memoryAccess = tokens.access_token;
    memoryRefresh = tokens.refresh_token;
    write(keys.access, memoryAccess);
    write(keys.refresh, memoryRefresh);
  },
  setLegacyToken: (token: string): void => {
    memoryLegacy = token.trim();
    write(keys.legacy, memoryLegacy);
  },
  clearTokens: (): void => {
    memoryAccess = "";
    memoryRefresh = "";
    write(keys.access, "");
    write(keys.refresh, "");
  },
  clearAll: (): void => {
    memoryAccess = "";
    memoryRefresh = "";
    memoryLegacy = "";
    write(keys.access, "");
    write(keys.refresh, "");
    write(keys.legacy, "");
  },
};

export function publishLogout(): void {
  window.dispatchEvent(new Event(localLogoutEvent));
  if ("BroadcastChannel" in window) {
    const channel = new BroadcastChannel(channelName);
    channel.postMessage({ type: "logout" });
    channel.close();
  }
  try {
    window.localStorage.setItem(keys.logoutEvent, String(Date.now()));
    window.localStorage.removeItem(keys.logoutEvent);
  } catch {
    // BroadcastChannel or the same-tab event still covers supported environments.
  }
}

export function subscribeToLogout(listener: () => void): () => void {
  const onLocal = (): void => listener();
  const onStorage = (event: StorageEvent): void => {
    if (event.key === keys.logoutEvent) listener();
  };
  window.addEventListener(localLogoutEvent, onLocal);
  window.addEventListener("storage", onStorage);

  const channel = "BroadcastChannel" in window ? new BroadcastChannel(channelName) : undefined;
  if (channel) {
    channel.onmessage = (event: MessageEvent<unknown>): void => {
      if (
        typeof event.data === "object" &&
        event.data !== null &&
        "type" in event.data &&
        event.data.type === "logout"
      ) {
        listener();
      }
    };
  }

  return () => {
    window.removeEventListener(localLogoutEvent, onLocal);
    window.removeEventListener("storage", onStorage);
    channel?.close();
  };
}
