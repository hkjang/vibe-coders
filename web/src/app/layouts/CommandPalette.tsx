import * as Dialog from "@radix-ui/react-dialog";
import { ExternalLink, Search, X } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { useNavigate } from "react-router";

import { useAuth } from "@/app/auth/AuthProvider";
import { featurePath, resolveFeature } from "@/config/migration-registry";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { canOpenLegacyAdmin } from "@/shared/permissions/legacy-admin";

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase("ko-KR");
}

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps): React.JSX.Element {
  const auth = useAuth();
  const { user, backendVersion, features, legacyFallback } = auth;
  const showLegacyAdmin = canOpenLegacyAdmin(auth);
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const listboxId = useId();

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

  const results = useMemo(() => {
    const needle = normalize(query);
    if (!needle) return available;
    return available.filter(({ feature }) =>
      normalize(
        [feature.title, feature.group, feature.featureId, feature.appPath, ...feature.keywords].join(" "),
      ).includes(needle),
    );
  }, [available, query]);

  const selectedIndex = results.length ? Math.min(activeIndex, results.length - 1) : 0;
  const activeResult = results[selectedIndex];
  const activeOptionId = activeResult
    ? `${listboxId}-${activeResult.feature.featureId.replaceAll(".", "-")}`
    : undefined;

  useEffect(() => {
    if (!activeOptionId) return;
    document.getElementById(activeOptionId)?.scrollIntoView({ block: "nearest" });
  }, [activeOptionId]);

  const updateOpen = (nextOpen: boolean): void => {
    setActiveIndex(0);
    if (!nextOpen) setQuery("");
    onOpenChange(nextOpen);
  };

  const go = (path: string): void => {
    navigate(path);
    updateOpen(false);
  };

  const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (!results.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((selectedIndex + 1) % results.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((selectedIndex - 1 + results.length) % results.length);
    } else if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(results.length - 1);
    } else if (event.key === "Enter" && activeResult) {
      event.preventDefault();
      go(featurePath(activeResult.feature));
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
                메뉴와 기능을 검색해 바로 이동합니다.
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
              placeholder="메뉴, 기능, 경로 검색"
              autoComplete="off"
              autoFocus
            />
            <kbd>Esc</kbd>
          </label>
          <div id={listboxId} className="command-results" role="listbox" aria-label="검색 결과">
            {results.length ? (
              results.map(({ feature, effective }, index) => (
                <button
                  id={`${listboxId}-${feature.featureId.replaceAll(".", "-")}`}
                  className="command-result"
                  key={feature.featureId}
                  role="option"
                  tabIndex={-1}
                  aria-selected={index === selectedIndex}
                  onPointerMove={() => setActiveIndex(index)}
                  onClick={() => go(featurePath(feature))}
                >
                  <span>
                    <strong>{feature.title}</strong>
                    <small>{feature.group}</small>
                  </span>
                  <Badge tone={effective.status === "legacy" ? "warning" : "info"}>
                    {effective.status === "preview_read_only" ? "Read Only" : effective.status}
                  </Badge>
                </button>
              ))
            ) : (
              <p className="command-empty">검색 결과가 없습니다.</p>
            )}
          </div>
          <div className="command-footer">
            <span>권한이 있는 기능만 표시됩니다.</span>
            {showLegacyAdmin ? (
              <a href="/admin">
                Legacy Admin <ExternalLink aria-hidden="true" />
              </a>
            ) : null}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
