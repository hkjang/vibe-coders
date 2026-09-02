import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export type ThemePreference = "dark" | "light" | "system";
export type DensityPreference = "compact" | "comfortable" | "default";
export type RefreshInterval = 0 | 15 | 30 | 60;

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

export const usePreferences = create<PreferenceState>()(
  persist(
    (set) => ({
      theme: "system",
      density: "default",
      refreshInterval: 30,
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
