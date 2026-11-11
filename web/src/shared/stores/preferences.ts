import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { migrationRegistry } from "@/config/migration-registry";

export type ThemePreference = "dark" | "light" | "system";
export type DensityPreference = "compact" | "comfortable" | "default";
export type RefreshInterval = 0 | 60 | 300;

interface PreferenceState {
  theme: ThemePreference;
  density: DensityPreference;
  refreshInterval: RefreshInterval;
  sidebarCollapsed: boolean;
  mobileSidebarOpen: boolean;
  collapsedGroups: string[];
  /** Feature ids most recently opened, newest first, so the palette can offer them back. */
  recentFeatures: string[];
  /** Ordered menu ids only; these browser preferences never contain resource URLs. */
  favoriteFeatures: string[];
  setTheme: (theme: ThemePreference) => void;
  setDensity: (density: DensityPreference) => void;
  setRefreshInterval: (seconds: RefreshInterval) => void;
  toggleSidebar: () => void;
  setMobileSidebarOpen: (open: boolean) => void;
  toggleGroup: (group: string) => void;
  rememberFeature: (featureId: string) => void;
  clearRecentFeatures: () => void;
  toggleFavorite: (featureId: string) => void;
  moveFavorite: (featureId: string, adjacentId: string) => void;
  clearFavorites: () => void;
}

/** Enough to answer "where was I?" without turning the palette into a history list. */
const recentFeatureLimit = 5;
const knownFeatureIds = new Set<string>(migrationRegistry.map((feature) => feature.featureId));

export function safeFeatureIds(value: unknown, limit = knownFeatureIds.size): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(value.filter((id): id is string => typeof id === "string" && knownFeatureIds.has(id))),
  ].slice(0, limit);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function safeRefreshInterval(value: unknown): RefreshInterval {
  return value === 60 || value === 300 ? value : 0;
}

function mergePersistedPreferences(persistedState: unknown, currentState: PreferenceState): PreferenceState {
  if (!isRecord(persistedState)) return currentState;
  const theme = persistedState.theme;
  const density = persistedState.density;
  const collapsedGroups = persistedState.collapsedGroups;
  return {
    ...currentState,
    theme: theme === "dark" || theme === "light" || theme === "system" ? theme : currentState.theme,
    density:
      density === "compact" || density === "comfortable" || density === "default"
        ? density
        : currentState.density,
    refreshInterval: safeRefreshInterval(persistedState.refreshInterval),
    sidebarCollapsed:
      typeof persistedState.sidebarCollapsed === "boolean"
        ? persistedState.sidebarCollapsed
        : currentState.sidebarCollapsed,
    collapsedGroups: Array.isArray(collapsedGroups)
      ? collapsedGroups.filter((group): group is string => typeof group === "string")
      : currentState.collapsedGroups,
    recentFeatures: safeFeatureIds(persistedState.recentFeatures, recentFeatureLimit),
    favoriteFeatures: safeFeatureIds(persistedState.favoriteFeatures),
  };
}

export const usePreferences = create<PreferenceState>()(
  persist(
    (set) => ({
      theme: "system",
      density: "default",
      // Operational summary endpoints can aggregate the full retention window.
      // Keep polling opt-in so a fresh console cannot create background DB load.
      refreshInterval: 0,
      sidebarCollapsed: false,
      mobileSidebarOpen: false,
      collapsedGroups: [],
      recentFeatures: [],
      favoriteFeatures: [],
      setTheme: (theme) => set({ theme }),
      setDensity: (density) => set({ density }),
      setRefreshInterval: (refreshInterval) => set({ refreshInterval }),
      toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
      setMobileSidebarOpen: (mobileSidebarOpen) => set({ mobileSidebarOpen }),
      toggleGroup: (group) =>
        set((state) => ({
          collapsedGroups: state.collapsedGroups.includes(group)
            ? state.collapsedGroups.filter((value) => value !== group)
            : [...state.collapsedGroups, group],
        })),
      rememberFeature: (featureId) =>
        set((state) =>
          !knownFeatureIds.has(featureId) || state.recentFeatures[0] === featureId
            ? state
            : {
                recentFeatures: [
                  featureId,
                  ...state.recentFeatures.filter((value) => value !== featureId),
                ].slice(0, recentFeatureLimit),
              },
        ),
      clearRecentFeatures: () => set({ recentFeatures: [] }),
      toggleFavorite: (featureId) =>
        set((state) => {
          if (!knownFeatureIds.has(featureId)) return state;
          const favorites = safeFeatureIds(state.favoriteFeatures);
          return {
            favoriteFeatures: favorites.includes(featureId)
              ? favorites.filter((id) => id !== featureId)
              : [...favorites, featureId],
          };
        }),
      moveFavorite: (featureId, adjacentId) =>
        set((state) => {
          const favorites = safeFeatureIds(state.favoriteFeatures);
          const from = favorites.indexOf(featureId);
          const to = favorites.indexOf(adjacentId);
          if (from < 0 || to < 0 || from === to) return state;
          [favorites[from], favorites[to]] = [adjacentId, featureId];
          return { favoriteFeatures: favorites };
        }),
      clearFavorites: () => set({ favoriteFeatures: [] }),
    }),
    {
      name: "vibe.app.preferences.v1",
      storage: createJSONStorage(() => localStorage),
      merge: mergePersistedPreferences,
      partialize: (state) => ({
        theme: state.theme,
        density: state.density,
        refreshInterval: state.refreshInterval,
        sidebarCollapsed: state.sidebarCollapsed,
        collapsedGroups: state.collapsedGroups,
        recentFeatures: state.recentFeatures,
        favoriteFeatures: state.favoriteFeatures,
      }),
    },
  ),
);
