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
let sessionEpoch = 0;
const sessionListeners = new Set<() => void>();

function advanceSession(): void {
  sessionEpoch += 1;
  sessionListeners.forEach((listener) => {
    try {
      listener();
    } catch {
      /* One consumer must not interrupt a security boundary. */
    }
  });
}

function writeTokens(tokens: Pick<TokenPair, "access_token" | "refresh_token">): void {
  memoryAccess = tokens.access_token;
  memoryRefresh = tokens.refresh_token;
  write(keys.access, memoryAccess);
  write(keys.refresh, memoryRefresh);
}

export const tokenStore = {
  // A browser-local generation, never a persisted user/session identifier.
  getSessionEpoch: (): number => sessionEpoch,
  subscribeSession: (listener: () => void): (() => void) => {
    sessionListeners.add(listener);
    return () => {
      sessionListeners.delete(listener);
    };
  },
  getAccessToken: (): string => memoryAccess,
  getRefreshToken: (): string => memoryRefresh,
  getLegacyToken: (): string => memoryLegacy,
  saveTokens: (tokens: Pick<TokenPair, "access_token" | "refresh_token">): void => {
    writeTokens(tokens);
    advanceSession();
  },
  // Refresh rotates credentials within the same session, not its async ownership.
  refreshTokens: writeTokens,
  setLegacyToken: (token: string): void => {
    memoryAccess = "";
    memoryRefresh = "";
    write(keys.access, "");
    write(keys.refresh, "");
    memoryLegacy = token.trim();
    write(keys.legacy, memoryLegacy);
    advanceSession();
  },
  clearTokens: (): void => {
    memoryAccess = "";
    memoryRefresh = "";
    write(keys.access, "");
    write(keys.refresh, "");
    advanceSession();
  },
  clearAll: (): void => {
    memoryAccess = "";
    memoryRefresh = "";
    memoryLegacy = "";
    write(keys.access, "");
    write(keys.refresh, "");
    write(keys.legacy, "");
    advanceSession();
  },
};

const logoutListeners = new Set<() => void>();
const seenLogoutIds = new Set<string>();
let stopLogoutTransport: (() => void) | undefined;

function receiveLogout(id?: string): void {
  if (id) {
    if (seenLogoutIds.has(id)) return;
    seenLogoutIds.add(id);
    // Delivery deduplication only; no user identifier or persistent history.
    if (seenLogoutIds.size > 64) {
      const oldest = seenLogoutIds.values().next().value;
      if (oldest !== undefined) seenLogoutIds.delete(oldest);
    }
  }
  tokenStore.clearAll();
  logoutListeners.forEach((listener) => {
    try {
      listener();
    } catch {
      /* Keep other guards and cross-tab delivery running. */
    }
  });
}

function logoutId(value: unknown): string | undefined {
  // Older clients sent a timestamp only. Keep accepting those as unkeyed events.
  return typeof value === "string" && /^\d{13}-[a-z0-9]{1,32}$/.test(value) ? value : undefined;
}

export function publishLogout(): void {
  // This nonce only deduplicates two delivery transports; it grants no authority.
  const id = `${Date.now()}-${Math.random().toString(36).slice(2) || "0"}`;
  receiveLogout(id);
  window.dispatchEvent(new CustomEvent(localLogoutEvent, { detail: { id } }));
  try {
    if ("BroadcastChannel" in window) {
      const channel = new BroadcastChannel(channelName);
      try {
        channel.postMessage({ type: "logout", id });
      } finally {
        channel.close();
      }
    }
  } catch {
    /* Storage fallback and same-tab logout must still complete. */
  }
  try {
    window.localStorage.setItem(keys.logoutEvent, id);
    window.localStorage.removeItem(keys.logoutEvent);
  } catch {
    // BroadcastChannel or the same-tab event still covers supported environments.
  }
}

function listenForLogout(): () => void {
  const onLocal = (event: Event): void => {
    const detail: unknown = event instanceof CustomEvent ? event.detail : undefined;
    receiveLogout(
      typeof detail === "object" && detail !== null && "id" in detail ? logoutId(detail.id) : undefined,
    );
  };
  const onStorage = (event: StorageEvent): void => {
    if (event.key === keys.logoutEvent && event.newValue !== null) receiveLogout(logoutId(event.newValue));
  };
  window.addEventListener(localLogoutEvent, onLocal);
  window.addEventListener("storage", onStorage);

  let channel: BroadcastChannel | undefined;
  try {
    channel = "BroadcastChannel" in window ? new BroadcastChannel(channelName) : undefined;
  } catch {
    /* Storage events still synchronize tabs when the channel is unavailable. */
  }
  if (channel) {
    channel.onmessage = (event: MessageEvent<unknown>): void => {
      if (
        typeof event.data === "object" &&
        event.data !== null &&
        "type" in event.data &&
        event.data.type === "logout"
      ) {
        receiveLogout("id" in event.data ? logoutId(event.data.id) : undefined);
      }
    };
  }

  return () => {
    window.removeEventListener(localLogoutEvent, onLocal);
    window.removeEventListener("storage", onStorage);
    channel?.close();
  };
}

export function subscribeToLogout(listener: () => void): () => void {
  logoutListeners.add(listener);
  if (!stopLogoutTransport) stopLogoutTransport = listenForLogout();
  return () => {
    logoutListeners.delete(listener);
    if (logoutListeners.size === 0) {
      stopLogoutTransport?.();
      stopLogoutTransport = undefined;
    }
  };
}
