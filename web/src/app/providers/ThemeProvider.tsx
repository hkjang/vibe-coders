import { useLayoutEffect, type PropsWithChildren } from "react";

import { applyTheme } from "@/app/providers/theme";

import { usePreferences } from "@/shared/stores/preferences";

export function ThemeProvider({ children }: PropsWithChildren): React.JSX.Element {
  const theme = usePreferences((state) => state.theme);
  const density = usePreferences((state) => state.density);

  useLayoutEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = (): void => {
      applyTheme(theme, media.matches);
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);

  useLayoutEffect(() => {
    document.documentElement.dataset.density = density;
  }, [density]);

  return <>{children}</>;
}
