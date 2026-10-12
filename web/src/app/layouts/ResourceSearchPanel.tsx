import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useAuth } from "@/app/auth/AuthProvider";
import { resolveFeature } from "@/config/migration-registry";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { isAppError } from "@/shared/api/error";
import type { ResourceKind } from "@/shared/api/resource-search";
import { tokenStore } from "@/shared/auth/token-store";
import { Button } from "@/shared/components/ui/Button";
import { containsPotentialSecret } from "@/shared/security/secrets";
import { resourceSearchPath, resourceSearchTargets } from "./resource-search-items";

interface Props {
  go: (path: string) => void;
  onComposingChange?: (composing: boolean) => void;
}

export default function ResourceSearchPanel({ go, onComposingChange }: Props): React.JSX.Element {
  const auth = useAuth();
  const epoch = useSyncExternalStore(tokenStore.subscribeSession, tokenStore.getSessionEpoch);
  const allowed = (Object.keys(resourceSearchTargets) as ResourceKind[]).filter((kind) => {
    const feature = auth.features.find((item) => item.featureId === resourceSearchTargets[kind].featureId);
    if (!feature || !auth.user?.scopes.includes("admin:read")) return false;
    const effective = resolveFeature(feature, auth.user, auth.backendVersion, {
      legacyFallback: auth.legacyFallback,
    });
    return effective.permitted && effective.status !== "legacy" && effective.status !== "hidden";
  });
  const owner = JSON.stringify([
    epoch,
    auth.mode,
    auth.user?.id,
    auth.user?.role,
    auth.user?.roles,
    auth.user?.team_id,
    auth.user?.scopes,
    allowed,
    auth.credentialPrefixes,
  ]);
  return (
    <ResourceSearchContent
      key={owner}
      owner={owner}
      allowed={allowed}
      go={go}
      onComposingChange={onComposingChange}
    />
  );
}

function ResourceSearchContent({
  owner,
  allowed,
  go,
  onComposingChange,
}: Props & { owner: string; allowed: ResourceKind[] }): React.JSX.Element {
  const auth = useAuth();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [active, setActive] = useState(0);
  const [composing, setComposing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  useEffect(() => () => onComposingChange?.(false), [onComposingChange]);
  const value = query.normalize("NFC").trim();
  const unsafe = containsPotentialSecret(value, auth.credentialPrefixes);
  const valid = [...value].length >= 2 && [...value].length <= 128 && !unsafe;
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), 300);
    return () => window.clearTimeout(timer);
  }, [value]);
  const ready = valid && !composing && value === debounced && allowed.length > 0;
  const result = useQuery({
    queryKey: ["resource-search", owner, debounced, allowed],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.admin.resourceSearch, {
        body: { query: debounced, kinds: allowed },
        signal,
      }),
    enabled: ready,
    retry: false,
    gcTime: 0,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  const groups = ready ? result.data?.groups : undefined;
  const items = useMemo(
    () =>
      (groups ?? []).flatMap((group) => {
        if (group.status !== "ok" || !allowed.includes(group.kind)) return [];
        return group.items.flatMap((item) => {
          if (item.kind !== group.kind || containsPotentialSecret(item.title, auth.credentialPrefixes))
            return [];
          const path = resourceSearchPath(item.kind, item.id, auth.credentialPrefixes);
          return path ? [{ ...item, path }] : [];
        });
      }),
    [groups, allowed, auth.credentialPrefixes],
  );
  const index = Math.min(active, Math.max(0, items.length - 1));
  const optionId = items.length ? `${listId}-${index}` : undefined;
  useEffect(() => {
    if (optionId) document.getElementById(optionId)?.scrollIntoView({ block: "nearest" });
  }, [optionId]);
  const pending = valid && allowed.length > 0 && (!ready || result.isFetching);
  const partial = groups?.some((group) => group.status !== "ok");
  const limited = groups?.some((group) => group.limited);
  const rawRequestId =
    result.data?.request_id ?? (isAppError(result.error) ? result.error.requestId : undefined);
  const requestId =
    ready &&
    rawRequestId &&
    /^[A-Za-z0-9_-]{1,128}$/.test(rawRequestId) &&
    !containsPotentialSecret(rawRequestId, auth.credentialPrefixes)
      ? rawRequestId
      : undefined;
  return (
    <>
      <p className="command-footer">
        공급자·워크플로·업무 앱·스킬의 이름을 검색합니다. 종류별 최대 10개이며 업무 본문은 검색하지 않습니다.
      </p>
      <label className="command-search">
        <span className="sr-only">자원 이름 검색</span>
        <Search aria-hidden="true" />
        <input
          ref={inputRef}
          autoFocus
          autoComplete="off"
          aria-label="자원 이름 검색"
          role="combobox"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-expanded={items.length > 0}
          aria-activedescendant={optionId}
          value={query}
          placeholder="자원 이름 두 글자 이상 입력"
          maxLength={256}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onCompositionStart={() => {
            setComposing(true);
            onComposingChange?.(true);
          }}
          onCompositionEnd={() => {
            setComposing(false);
            onComposingChange?.(false);
          }}
          onKeyDown={(event) => {
            if (composing || event.nativeEvent.isComposing || event.keyCode === 229) {
              if (event.key === "Escape") event.preventDefault();
              return;
            }
            if (!items.length) return;
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActive((index + 1) % items.length);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((index - 1 + items.length) % items.length);
            } else if (event.key === "Home") {
              event.preventDefault();
              setActive(0);
            } else if (event.key === "End") {
              event.preventDefault();
              setActive(items.length - 1);
            } else if (event.key === "Enter") {
              event.preventDefault();
              const item = items[index];
              if (item) go(item.path);
            }
          }}
        />
      </label>
      <div className="command-footer" role="status" aria-live="polite" aria-atomic="true">
        {unsafe
          ? "민감정보로 보이는 검색어는 전송하지 않습니다. 이름만 입력하세요."
          : !allowed.length
            ? "검색할 수 있는 자원 권한이 없습니다."
            : !valid
              ? "이름을 2~128자로 입력하세요. 검색어는 저장하지 않습니다."
              : pending
                ? "자원을 검색하고 있습니다…"
                : result.isError
                  ? "자원 검색에 실패했습니다. 다시 시도하세요."
                  : `${items.length}개의 자원을 찾았습니다.`}
        {partial ? " 일부 종류는 권한이 없거나 조회에 실패했습니다." : ""}
        {limited ? " 결과가 더 있습니다. 이름을 더 구체적으로 입력하세요." : ""}
      </div>
      {ready && (result.isError || partial) ? (
        <Button variant="secondary" disabled={result.isFetching} onClick={() => void result.refetch()}>
          자원 검색 다시 시도
        </Button>
      ) : null}
      {ready && (result.isError || partial) && requestId ? (
        <p className="command-footer">요청 ID: {requestId}</p>
      ) : null}
      <div
        id={listId}
        className="command-results"
        role="listbox"
        aria-label="자원 검색 결과"
        hidden={!items.length}
      >
        {items.map((item, position) => (
          <button
            key={`${item.kind}:${item.id}`}
            id={`${listId}-${position}`}
            type="button"
            className="command-result"
            role="option"
            tabIndex={-1}
            aria-selected={position === index}
            onPointerMove={() => setActive(position)}
            onClick={() => go(item.path)}
          >
            <span>
              <strong>{item.title}</strong>
              <small>{resourceSearchTargets[item.kind].title}</small>
            </span>
            <span>자원</span>
          </button>
        ))}
      </div>
    </>
  );
}
