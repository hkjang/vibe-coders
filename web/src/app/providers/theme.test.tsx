import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useEffect } from "react";

import { ThemeProvider } from "@/app/providers/ThemeProvider";
import { initializeAppearance } from "@/app/providers/theme";
import { usePreferences } from "@/shared/stores/preferences";

let systemDark = true;
let listener: (() => void) | undefined;
const removeListener = vi.fn();

beforeEach(() => {
  systemDark = true;
  listener = undefined;
  removeListener.mockClear();
  usePreferences.setState({ theme: "system", density: "compact" });
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.density;
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query) =>
      ({
        media: query,
        get matches() {
          return systemDark;
        },
        addEventListener: (_event: string, callback: () => void) => {
          listener = callback;
        },
        removeEventListener: removeListener,
      }) as unknown as MediaQueryList,
  );
});
afterEach(() => vi.restoreAllMocks());

it.each(["light", "dark", "system"] as const)("%s 설정을 React 표시 전에 적용한다", (theme) => {
  usePreferences.setState({ theme });
  initializeAppearance();
  const resolved = theme === "system" ? "dark" : theme;
  expect(document.documentElement.dataset.theme).toBe(resolved);
  expect(document.documentElement.style.colorScheme).toBe(resolved);
  expect(document.documentElement.dataset.density).toBe("compact");
});

it("하위 화면의 조회 효과 전에 테마를 적용하고 시스템 변경과 명시 설정을 구분한다", () => {
  const observed: Array<string | undefined> = [];
  function Page() {
    useEffect(() => {
      observed.push(document.documentElement.dataset.theme);
    }, []);
    return <p>운영 상태</p>;
  }
  const mounted = render(
    <ThemeProvider>
      <Page />
    </ThemeProvider>,
  );
  expect(observed).toEqual(["dark"]);
  act(() => {
    systemDark = false;
    listener?.();
  });
  expect(document.documentElement.dataset.theme).toBe("light");
  act(() => usePreferences.getState().setTheme("dark"));
  expect(document.documentElement.dataset.theme).toBe("dark");
  act(() => listener?.());
  expect(document.documentElement.dataset.theme).toBe("dark");
  act(() => usePreferences.getState().setDensity("comfortable"));
  expect(document.documentElement.dataset.density).toBe("comfortable");
  mounted.unmount();
  expect(removeListener).toHaveBeenCalled();
});
