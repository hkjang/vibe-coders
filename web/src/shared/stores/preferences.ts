import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

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
  setTheme: (theme: ThemePreference) => void;
  setDensity: (density: DensityPreference) => void;
  setRefreshInterval: (seconds: RefreshInterval) => void;
  toggleSidebar: () => void;
  setMobileSidebarOpen: (open: boolean) => void;
  toggleGroup: (group: string) => void;
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
      }),
    },
  ),
);
