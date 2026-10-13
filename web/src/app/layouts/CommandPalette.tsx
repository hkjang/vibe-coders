import { LegacyLink } from "@/shared/components/ui/LegacyLink";

import * as Dialog from "@radix-ui/react-dialog";
import { ExternalLink, Search, X } from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import { useNavigate } from "react-router";

import { useAuth } from "@/app/auth/AuthProvider";
import { jumpItems, matchesQuery, type CommandItem } from "@/app/layouts/command-items";
import { featurePath, resolveFeature } from "@/config/migration-registry";
import { commandPaletteLabels, migrationStatusLabels, uiLabels } from "@/config/ui-labels";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { canOpenLegacyAdmin } from "@/shared/permissions/legacy-admin";
import { usePreferences } from "@/shared/stores/preferences";
import { tokenStore } from "@/shared/auth/token-store";
import { rememberCommand } from "./recent-commands";
import { useConsoleActions } from "./use-console-actions";

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocusRef: RefObject<HTMLElement | null>;
  /** Opens the shortcut sheet, offered here so the palette can teach the rest. */
  onShowShortcuts?: () => void;
}

const ResourceSearchPanel = lazy(() => import("./ResourceSearchPanel"));

const kindLabels: Record<CommandItem["kind"], string> = {
  action: "명령",
  feature: "이동",
  jump: "바로 찾기",
  recent: "최근",
  recentAction: commandPaletteLabels.recentCommand,
};

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase("ko-KR");
}

export function CommandPalette(props: CommandPaletteProps): React.JSX.Element {
  const auth = useAuth();
  const epoch = useSyncExternalStore(tokenStore.subscribeSession, tokenStore.getSessionEpoch);
  // Remount on ownership changes, including A → B → A, so no previous search or
  // command history survives a session/account/permission boundary. Never persist.
  const owner = JSON.stringify([
    epoch,
    auth.mode,
    auth.user?.id,
    auth.user?.team_id,
    auth.user?.role,
    auth.user?.roles,
    auth.user?.scopes,
  ]);
  return <CommandPaletteContent key={owner} {...props} />;
}

function CommandPaletteContent({
  open,
  onOpenChange,
  returnFocusRef,
  onShowShortcuts,
}: CommandPaletteProps): React.JSX.Element {
  const auth = useAuth();
  const { user, backendVersion, features, legacyFallback } = auth;
  const showLegacyAdmin = canOpenLegacyAdmin(auth);
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [resourceMode, setResourceMode] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [recentCommands, setRecentCommands] = useState<string[]>([]);
  const composing = useRef(false);
  const setComposing = useCallback((value: boolean) => {
    composing.current = value;
  }, []);
  const [navigating, setNavigating] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();
  const recentFeatures = usePreferences((state) => state.recentFeatures);

  const updateOpen = useCallback(
    (nextOpen: boolean): void => {
      setActiveIndex(0);
      if (!nextOpen) {
        setQuery("");
        setResourceMode(false);
      }
      onOpenChange(nextOpen);
    },
    [onOpenChange],
  );

  useEffect(() => {
    if (!open) composing.current = false;
  }, [open]);

  const go = useCallback(
    (path: string): void => {
      setNavigating(true);
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

  const actions = useConsoleActions(run, onShowShortcuts);
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
    // ID filters are a React request-explorer capability; a Legacy-only or
    // forbidden destination cannot safely consume the query-string jump.
    const canJump = available.some(
      ({ feature, effective }) =>
        feature.featureId === "observability.requests" && effective.status !== "legacy",
    );
    const commands = actions.map((item): CommandItem => ({
      ...item,
      run: () => {
        setRecentCommands((history) => rememberCommand(history, item.id));
        item.run();
      },
    }));
    // Resolve IDs against currently offered commands, preserving live setting
    // hints and callbacks instead of retaining snapshots or prior authority.
    const recent =
      needle === ""
        ? recentCommands.flatMap((id) => {
            const item = commands.find((command) => command.id === id);
            return item ? [{ ...item, kind: "recentAction" as const }] : [];
          })
        : [];
    return [
      ...(canJump ? jumpItems(query, go) : []),
      ...recent,
      ...ordered,
      ...commands.filter((item) => !recent.some((previous) => previous.id === item.id)),
    ].filter((item) => matchesQuery(item, needle));
  }, [actions, available, go, query, recentFeatures, recentCommands]);

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
    // IME confirmation/candidate navigation must not execute the selected command.
    // keyCode 229 covers browsers that clear isComposing on the confirming key.
    if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
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
        <Dialog.Content
          className="command-dialog"
          aria-describedby="command-description"
          onOpenAutoFocus={() => {
            setNavigating(false);
          }}
          onEscapeKeyDown={(event) => {
            if (composing.current || event.isComposing || event.keyCode === 229) event.preventDefault();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const trigger = returnFocusRef.current;
            const target =
              !navigating && trigger?.isConnected && !trigger.matches(":disabled")
                ? trigger
                : document.querySelector<HTMLElement>("#main-content");
            target?.focus();
          }}
        >
          <div className="command-heading">
            <div>
              <Dialog.Title>명령 팔레트</Dialog.Title>
              <Dialog.Description id="command-description">
                {resourceMode
                  ? "권한이 있는 자원의 이름을 검색하고 해당 상세 화면을 엽니다."
                  : "메뉴와 명령을 검색하고, 요청·추적·세션 ID를 붙여넣어 바로 찾아갑니다."}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button size="icon" variant="ghost" aria-label="명령 팔레트 닫기">
                <X aria-hidden="true" />
              </Button>
            </Dialog.Close>
          </div>
          <div className="command-footer" aria-label="검색 범위">
            <Button variant="ghost" aria-pressed={!resourceMode} onClick={() => setResourceMode(false)}>
              메뉴·명령
            </Button>
            <Button variant="ghost" aria-pressed={resourceMode} onClick={() => setResourceMode(true)}>
              자원 검색
            </Button>
          </div>
          {resourceMode ? (
            <Suspense fallback={<p role="status">자원 검색을 준비하고 있습니다…</p>}>
              <ResourceSearchPanel go={go} onComposingChange={setComposing} />
            </Suspense>
          ) : (
            <>
              {recentCommands.length > 0 ? (
                <div className="command-footer">
                  <span>{commandPaletteLabels.commandHistoryHint}</span>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setRecentCommands([]);
                      setActiveIndex(0);
                      searchRef.current?.focus();
                    }}
                  >
                    {commandPaletteLabels.clearCommands}
                  </Button>
                </div>
              ) : null}
              <label className="command-search">
                <span className="sr-only">메뉴 검색</span>
                <Search aria-hidden="true" />
                <input
                  ref={searchRef}
                  aria-label="메뉴 검색"
                  role="combobox"
                  aria-autocomplete="list"
                  aria-controls={listboxId}
                  aria-expanded={open && items.length > 0}
                  aria-activedescendant={activeOptionId}
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setActiveIndex(0);
                  }}
                  onKeyDown={handleSearchKeyDown}
                  onCompositionStart={() => {
                    composing.current = true;
                  }}
                  onCompositionEnd={() => {
                    composing.current = false;
                  }}
                  placeholder="메뉴·명령 검색, 또는 요청·추적·세션 ID 붙여넣기"
                  autoComplete="off"
                  autoFocus
                />
                <kbd>Esc</kbd>
              </label>
              <p className="sr-only" role="status" aria-atomic="true">
                {commandPaletteLabels.results(items.length)}
              </p>
              <div
                id={listboxId}
                className="command-results"
                role="listbox"
                aria-label="검색 결과"
                hidden={!items.length}
              >
                {items.map((item, index) => (
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
                ))}
              </div>
              {!items.length ? (
                <div className="command-empty">
                  <p>{commandPaletteLabels.empty}</p>
                  <p>{commandPaletteLabels.emptyHint}</p>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setQuery("");
                      setActiveIndex(0);
                      searchRef.current?.focus();
                    }}
                  >
                    {commandPaletteLabels.clear}
                  </Button>
                </div>
              ) : null}
            </>
          )}
          <div className="command-footer">
            <span>{commandPaletteLabels.keyboardHint}</span>
            {showLegacyAdmin ? (
              <LegacyLink href="/admin">
                {uiLabels.legacyAdmin} <ExternalLink aria-hidden="true" />
              </LegacyLink>
            ) : null}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
