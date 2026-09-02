import { useEffect, type PropsWithChildren } from "react";

import { usePreferences } from "@/shared/stores/preferences";

export function ThemeProvider({ children }: PropsWithChildren): React.JSX.Element {
  const theme = usePreferences((state) => state.theme);
  const density = usePreferences((state) => state.density);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = (): void => {
      const resolved = theme === "system" ? (media.matches ? "dark" : "light") : theme;
      document.documentElement.dataset.theme = resolved;
      document.documentElement.style.colorScheme = resolved;
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);

  useEffect(() => {
    document.documentElement.dataset.density = density;
  }, [density]);

  return <>{children}</>;
}
