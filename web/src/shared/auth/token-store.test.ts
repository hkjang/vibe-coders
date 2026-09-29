import { afterEach, describe, expect, it, vi } from "vitest";

import { publishLogout, subscribeToLogout, tokenStore } from "@/shared/auth/token-store";

afterEach(() => tokenStore.clearAll());

describe("browser session generation", () => {
  it("changes only on authentication boundaries, not token refresh rotation", () => {
    const initial = tokenStore.getSessionEpoch();
    tokenStore.saveTokens({ access_token: "first", refresh_token: "first-refresh" });
    const first = tokenStore.getSessionEpoch();
    expect(first).toBeGreaterThan(initial);
    tokenStore.refreshTokens({ access_token: "rotated", refresh_token: "rotated-refresh" });
    expect(tokenStore.getSessionEpoch()).toBe(first);
    tokenStore.setLegacyToken(" legacy ");
    expect(tokenStore.getSessionEpoch()).toBeGreaterThan(first);
    expect(tokenStore.getAccessToken()).toBe("");
    expect(tokenStore.getRefreshToken()).toBe("");
    expect(tokenStore.getLegacyToken()).toBe("legacy");
    expect(window.localStorage.length).toBe(0);
  });

  it("clears credentials and notifies local subscribers before publishing cross-tab logout", () => {
    tokenStore.saveTokens({ access_token: "secret", refresh_token: "secret-refresh" });
    const posted = vi.spyOn(BroadcastChannel.prototype, "postMessage");
    const listener = vi.fn(() => expect(tokenStore.getAccessToken()).toBe(""));
    const unsubscribe = subscribeToLogout(listener);
    publishLogout();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(posted).toHaveBeenCalledWith({ type: "logout", id: expect.any(String) });
    expect(window.localStorage.length).toBe(0);
    unsubscribe();
    publishLogout();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("ends the session on a cross-tab storage signal and ignores its removal event", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToLogout(listener);
    tokenStore.saveTokens({ access_token: "old", refresh_token: "old-refresh" });
    const epoch = tokenStore.getSessionEpoch();
    window.dispatchEvent(new StorageEvent("storage", { key: "vibe.app.auth.logout-event", newValue: "1" }));
    expect(tokenStore.getSessionEpoch()).toBeGreaterThan(epoch);
    expect(tokenStore.getAccessToken()).toBe("");
    window.dispatchEvent(new StorageEvent("storage", { key: "vibe.app.auth.logout-event", newValue: null }));
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("clears once for all listeners and ignores the duplicate delivery after a new login", () => {
    const first = vi.fn();
    const second = vi.fn();
    const removeFirst = subscribeToLogout(first);
    const removeSecond = subscribeToLogout(second);
    const epoch = tokenStore.getSessionEpoch();
    const post = vi.spyOn(BroadcastChannel.prototype, "postMessage");
    publishLogout();
    expect(tokenStore.getSessionEpoch()).toBe(epoch + 1);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    const message = post.mock.calls[0]?.[0] as { id: string };
    tokenStore.saveTokens({ access_token: "new", refresh_token: "new-refresh" });
    window.dispatchEvent(
      new StorageEvent("storage", { key: "vibe.app.auth.logout-event", newValue: message.id }),
    );
    expect(tokenStore.getAccessToken()).toBe("new");
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    removeFirst();
    removeSecond();
  });

  it("keeps local logout working when BroadcastChannel and storage are denied", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToLogout(listener);
    tokenStore.saveTokens({ access_token: "old", refresh_token: "old-refresh" });
    vi.spyOn(BroadcastChannel.prototype, "postMessage").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(() => publishLogout()).not.toThrow();
    expect(tokenStore.getAccessToken()).toBe("");
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("isolates throwing subscribers so every guard and cross-tab transport still receives logout", () => {
    const removeBadSession = tokenStore.subscribeSession(() => {
      throw new Error("private state");
    });
    const removeBadLogout = subscribeToLogout(() => {
      throw new Error("private state");
    });
    const listener = vi.fn();
    const removeGood = subscribeToLogout(listener);
    const posted = vi.spyOn(BroadcastChannel.prototype, "postMessage");
    const storage = vi.spyOn(Storage.prototype, "setItem");
    expect(() => publishLogout()).not.toThrow();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(posted).toHaveBeenCalledOnce();
    expect(storage).toHaveBeenCalledWith("vibe.app.auth.logout-event", expect.any(String));
    removeBadSession();
    removeBadLogout();
    removeGood();
  });
});
