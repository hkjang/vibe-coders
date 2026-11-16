import { usePreferences, type ThemePreference } from "@/shared/stores/preferences";

export function applyTheme(theme: ThemePreference, systemDark: boolean): void {
  const resolved = theme === "system" ? (systemDark ? "dark" : "light") : theme;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
}

// Resolve persisted preferences before React creates any content. Descendants
// must inherit the same palette as their backgrounds from the first render.
export function initializeAppearance(): void {
  const { theme, density } = usePreferences.getState();
  applyTheme(theme, window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.density = density;
}
