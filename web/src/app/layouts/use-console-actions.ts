import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { preferenceLabels } from "@/config/ui-labels";
import { usePreferences } from "@/shared/stores/preferences";
import type { CommandItem } from "./command-items";

export function useConsoleActions(
  run: (action: () => void) => void,
  onShowShortcuts?: () => void,
): CommandItem[] {
  const queryClient = useQueryClient();
  const theme = usePreferences((state) => state.theme);
  const density = usePreferences((state) => state.density);
  const refreshInterval = usePreferences((state) => state.refreshInterval);
  const setTheme = usePreferences((state) => state.setTheme);
  const setDensity = usePreferences((state) => state.setDensity);
  const setRefreshInterval = usePreferences((state) => state.setRefreshInterval);
  const toggleSidebar = usePreferences((state) => state.toggleSidebar);
  /** The settings and one-off operations that otherwise live in the header menus. */
  const actions = useMemo((): CommandItem[] => {
    const list: CommandItem[] = [
      {
        id: "action:refresh",
        kind: "action",
        title: "지금 새로고침",
        hint: "열려 있는 화면의 데이터를 다시 불러옵니다",
        keywords: ["refresh", "reload", "갱신"],
        run: () => run(() => void queryClient.invalidateQueries()),
      },
      {
        id: "action:theme",
        kind: "action",
        title: `${preferenceLabels.theme} 전환`,
        hint: preferenceLabels[theme],
        keywords: ["theme", "dark", "light", "테마", "다크", "라이트"],
        run: () => run(() => setTheme(theme === "dark" ? "light" : theme === "light" ? "system" : "dark")),
      },
      {
        id: "action:density",
        kind: "action",
        title: `${preferenceLabels.density} 전환`,
        hint: preferenceLabels[density],
        keywords: ["density", "compact", "밀도"],
        run: () =>
          run(() =>
            setDensity(
              density === "compact" ? "comfortable" : density === "comfortable" ? "default" : "compact",
            ),
          ),
      },
      {
        id: "action:refresh-interval",
        kind: "action",
        title: "자동 갱신 주기 전환",
        hint: refreshInterval === 0 ? "사용 안 함" : `${refreshInterval / 60}분`,
        keywords: ["auto", "interval", "자동", "주기", "폴링"],
        run: () =>
          run(() => setRefreshInterval(refreshInterval === 0 ? 60 : refreshInterval === 60 ? 300 : 0)),
      },
      {
        id: "action:sidebar",
        kind: "action",
        title: "사이드바 접기/펼치기",
        keywords: ["sidebar", "menu", "사이드바", "메뉴"],
        run: () => run(toggleSidebar),
      },
    ];
    if (onShowShortcuts) {
      list.push({
        id: "action:shortcuts",
        kind: "action",
        title: "단축키 도움말",
        hint: "?",
        keywords: ["shortcut", "keyboard", "단축키", "키보드"],
        run: () => run(onShowShortcuts),
      });
    }
    return list;
  }, [
    density,
    onShowShortcuts,
    queryClient,
    refreshInterval,
    run,
    setDensity,
    setRefreshInterval,
    setTheme,
    theme,
    toggleSidebar,
  ]);

  return actions;
}
