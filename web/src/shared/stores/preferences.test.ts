import { describe, expect, it } from "vitest";

import { safeFeatureIds, safeRefreshInterval, usePreferences } from "@/shared/stores/preferences";

describe("preference safety", () => {
  it("keeps automatic refresh opt-in and retires unsafe legacy defaults", () => {
    expect(safeRefreshInterval(undefined)).toBe(0);
    expect(safeRefreshInterval(15)).toBe(0);
    expect(safeRefreshInterval(30)).toBe(0);
    expect(safeRefreshInterval(60)).toBe(60);
    expect(safeRefreshInterval(300)).toBe(300);
  });
  it("accepts only canonical menu ids and removes duplicates and malformed persisted entries", () => {
    expect(
      safeFeatureIds([
        "overview",
        "overview",
        "/app/overview?q=private",
        "unknown",
        null,
        {},
        "gateway.providers",
      ]),
    ).toEqual(["overview", "gateway.providers"]);
    expect(safeFeatureIds("overview")).toEqual([]);
    expect(safeFeatureIds(["overview", "gateway.providers"], 1)).toEqual(["overview"]);
  });
  it("does not store arbitrary URLs or credentials through navigation actions", () => {
    usePreferences.setState({ favoriteFeatures: [], recentFeatures: [] });
    usePreferences.getState().toggleFavorite("/app/overview?token=private");
    usePreferences.getState().rememberFeature("unknown-private-input");
    expect(usePreferences.getState().favoriteFeatures).toEqual([]);
    expect(usePreferences.getState().recentFeatures).toEqual([]);
    usePreferences.getState().toggleFavorite("gateway.providers");
    usePreferences.getState().moveFavorite("gateway.providers", "unknown");
    expect(usePreferences.getState().favoriteFeatures).toEqual(["gateway.providers"]);
    usePreferences.getState().clearFavorites();
  });
});
