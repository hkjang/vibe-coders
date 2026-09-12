import * as Dialog from "@radix-ui/react-dialog";
import { useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Search, X } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { useNavigate } from "react-router";

import { useAuth } from "@/app/auth/AuthProvider";
import { jumpItems, matchesQuery, type CommandItem } from "@/app/layouts/command-items";
import { featurePath, resolveFeature } from "@/config/migration-registry";
import { migrationStatusLabels, preferenceLabels, uiLabels } from "@/config/ui-labels";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { canOpenLegacyAdmin } from "@/shared/permissions/legacy-admin";
import { usePreferences } from "@/shared/stores/preferences";

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Opens the shortcut sheet, offered here so the palette can teach the rest. */
  onShowShortcuts?: () => void;
}

const kindLabels: Record<CommandItem["kind"], string> = {
  action: "명령",
  feature: "이동",
  jump: "바로 찾기",
  recent: "최근",
};

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase("ko-KR");
}

export function CommandPalette({
  open,
  onOpenChange,
  onShowShortcuts,
}: CommandPaletteProps): React.JSX.Element {
  const auth = useAuth();
  const { user, backendVersion, features, legacyFallback } = auth;
  const showLegacyAdmin = canOpenLegacyAdmin(auth);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const listboxId = useId();
  const theme = usePreferences((state) => state.theme);
  const density = usePreferences((state) => state.density);
  const refreshInterval = usePreferences((state) => state.refreshInterval);
  const recentFeatures = usePreferences((state) => state.recentFeatures);
  const setTheme = usePreferences((state) => state.setTheme);
  const setDensity = usePreferences((state) => state.setDensity);
  const setRefreshInterval = usePreferences((state) => state.setRefreshInterval);
  const toggleSidebar = usePreferences((state) => state.toggleSidebar);

  const updateOpen = useCallback(
    (nextOpen: boolean): void => {
      setActiveIndex(0);
      if (!nextOpen) setQuery("");
      onOpenChange(nextOpen);
    },
    [onOpenChange],
  );

  const go = useCallback(
    (path: string): void => {
      navigate(path);
      updateOpen(false);
    },
    [navigate, updateOpen],
  );

  const run = useCallback(
    (action: () => void): void => {
      action();
      updateOpen(false);
    },
    [updateOpen],
  );

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

  const available = useMemo(
    () =>
      features
        .map((feature) => ({
          feature,
          effective: resolveFeature(feature, user, backendVersion, { legacyFallback }),
        }))
        .filter(({ effective }) => effective.permitted && effective.status !== "hidden"),
    [backendVersion, features, legacyFallback, user],
  );

  const items = useMemo((): CommandItem[] => {
    const needle = normalize(query);
    const destinations: CommandItem[] = available.map(({ feature, effective }) => ({
      id: `feature:${feature.featureId}`,
      kind: recentFeatures.includes(feature.featureId) && needle === "" ? "recent" : "feature",
      title: feature.title,
      hint: feature.group,
      keywords: [
        feature.featureId,
        feature.appPath,
        ...feature.keywords,
        migrationStatusLabels[effective.status],
      ],
      run: () => go(featurePath(feature)),
    }));
    // With an empty box the palette answers "where was I?" first, then the full menu.
    const ordered =
      needle === ""
        ? [
            ...recentFeatures
              .map((featureId) => destinations.find((item) => item.id === `feature:${featureId}`))
              .filter((item): item is CommandItem => item !== undefined),
            ...destinations.filter((item) => item.kind !== "recent"),
          ]
        : destinations;
    // Destinations stay on top: navigating is the common case, and a command is one
    // typed word away. A pasted id outranks both, because it states an exact intent.
    return [...jumpItems(query, go), ...ordered, ...actions].filter((item) => matchesQuery(item, needle));
  }, [actions, available, go, query, recentFeatures]);

  const selectedIndex = items.length ? Math.min(activeIndex, items.length - 1) : 0;
  const activeResult = items[selectedIndex];
  const activeOptionId = activeResult
    ? `${listboxId}-${activeResult.id.replaceAll(/[.:/]/g, "-")}`
    : undefined;

  useEffect(() => {
    if (!activeOptionId) return;
    document.getElementById(activeOptionId)?.scrollIntoView({ block: "nearest" });
  }, [activeOptionId]);

  const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (!items.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((selectedIndex + 1) % items.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((selectedIndex - 1 + items.length) % items.length);
    } else if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(items.length - 1);
    } else if (event.key === "Enter" && activeResult) {
      event.preventDefault();
      activeResult.run();
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={updateOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="command-dialog" aria-describedby="command-description">
          <div className="command-heading">
            <div>
              <Dialog.Title>명령 팔레트</Dialog.Title>
              <Dialog.Description id="command-description">
                메뉴와 명령을 검색하고, 요청·추적·세션 ID를 붙여넣어 바로 찾아갑니다.
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button size="icon" variant="ghost" aria-label="명령 팔레트 닫기">
                <X aria-hidden="true" />
              </Button>
            </Dialog.Close>
          </div>
          <label className="command-search">
            <span className="sr-only">메뉴 검색</span>
            <Search aria-hidden="true" />
            <input
              aria-label="메뉴 검색"
              role="combobox"
              aria-autocomplete="list"
              aria-controls={listboxId}
              aria-expanded={open}
              aria-activedescendant={activeOptionId}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={handleSearchKeyDown}
              placeholder="메뉴·명령 검색, 또는 요청·추적·세션 ID 붙여넣기"
              autoComplete="off"
              autoFocus
            />
            <kbd>Esc</kbd>
          </label>
          <div id={listboxId} className="command-results" role="listbox" aria-label="검색 결과">
            {items.length ? (
              items.map((item, index) => (
                <button
                  id={`${listboxId}-${item.id.replaceAll(/[.:/]/g, "-")}`}
                  className="command-result"
                  key={item.id}
                  role="option"
                  tabIndex={-1}
                  aria-selected={index === selectedIndex}
                  onPointerMove={() => setActiveIndex(index)}
                  onClick={item.run}
                >
                  <span>
                    <strong>{item.title}</strong>
                    {item.hint ? <small>{item.hint}</small> : null}
                  </span>
                  <Badge tone={item.kind === "action" || item.kind === "jump" ? "muted" : "info"}>
                    {kindLabels[item.kind]}
                  </Badge>
                </button>
              ))
            ) : (
              <p className="command-empty">검색 결과가 없습니다.</p>
            )}
          </div>
          <div className="command-footer">
            <span>
              권한이 있는 기능만 표시됩니다. 단축키는 <kbd>?</kbd>
            </span>
            {showLegacyAdmin ? (
              <a href="/admin">
                {uiLabels.legacyAdmin} <ExternalLink aria-hidden="true" />
              </a>
            ) : null}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
