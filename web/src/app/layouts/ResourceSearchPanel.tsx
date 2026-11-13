import "./resource-search.css";
import { ResourceSearchScope, type SearchScope } from "./ResourceSearchScope";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useAuth } from "@/app/auth/AuthProvider";
import { resolveFeature, versionAtLeast } from "@/config/migration-registry";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { isAppError } from "@/shared/api/error";
import type { ResourceKind } from "@/shared/api/resource-search";
import { tokenStore } from "@/shared/auth/token-store";
import { Button } from "@/shared/components/ui/Button";
import { containsPotentialSecret } from "@/shared/security/secrets";
import { resourceSearchPath, resourceSearchReadScope, resourceSearchTargets } from "./resource-search-items";

interface Props {
  go: (path: string) => void;
  onComposingChange?: (composing: boolean) => void;
}

export default function ResourceSearchPanel({ go, onComposingChange }: Props): React.JSX.Element {
  const auth = useAuth();
  const epoch = useSyncExternalStore(tokenStore.subscribeSession, tokenStore.getSessionEpoch);
  const allowed = (Object.keys(resourceSearchTargets) as ResourceKind[]).filter((kind) => {
    if (
      (kind === "prompt_asset" || kind === "prompt_experiment") &&
      !versionAtLeast(auth.backendVersion, "v0.86.97")
    )
      return false;
    if (kind === "model" && !versionAtLeast(auth.backendVersion, "v0.86.102")) return false;
    if (kind === "api_key" && !versionAtLeast(auth.backendVersion, "v0.86.101")) return false;
    if (kind === "setting" && !versionAtLeast(auth.backendVersion, "v0.86.99")) return false;
    if (kind === "team" && !versionAtLeast(auth.backendVersion, "v0.86.79")) return false;
    if (kind === "account" && !versionAtLeast(auth.backendVersion, "v0.86.90")) return false;
    if (kind === "mcp_tool" && !versionAtLeast(auth.backendVersion, "v0.86.96")) return false;
    const feature = auth.features.find((item) => item.featureId === resourceSearchTargets[kind].featureId);
    if (!feature || !auth.user) return false;
    if (kind !== "policy" && !auth.user.scopes.includes("admin:read")) return false;
    if (!auth.user.scopes.includes(resourceSearchReadScope(kind))) return false;
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
  const [scope, setScope] = useState<SearchScope>("all");
  const kinds = useMemo(
    () => (scope === "all" ? allowed : allowed.filter((kind) => kind === scope)),
    [allowed, scope],
  );
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
  const ready = valid && !composing && value === debounced && kinds.length > 0;
  const result = useQuery({
    queryKey: ["resource-search", owner, debounced, kinds],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.admin.resourceSearch, {
        body: { query: debounced, kinds },
        signal,
      }),
    enabled: ready,
    retry: false,
    gcTime: 0,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  // Query retains the last success during refetch and after refetch errors.
  // Those rows are no longer current navigation authority (including 401/403).
  const groups =
    ready && result.isSuccess && !result.isFetching
      ? kinds.flatMap((kind) => result.data.groups.filter((group) => group.kind === kind))
      : undefined;
  const items = useMemo(
    () =>
      (groups ?? []).flatMap((group) => {
        if (
          (group.status !== "ok" && !(group.kind === "model" && group.status === "partial")) ||
          !kinds.includes(group.kind)
        )
          return [];
        return group.items.flatMap((item) => {
          if (item.kind !== group.kind || containsPotentialSecret(item.title, auth.credentialPrefixes))
            return [];
          if (
            item.kind === "model" &&
            (!item.provider_label || containsPotentialSecret(item.provider_label, auth.credentialPrefixes))
          )
            return [];
          const path = resourceSearchPath(
            item.kind,
            item.id,
            auth.credentialPrefixes,
            item.server_label,
            item.provider_ref,
          );
          return path ? [{ ...item, path }] : [];
        });
      }),
    [groups, kinds, auth.credentialPrefixes],
  );
  const index = Math.min(active, Math.max(0, items.length - 1));
  const optionId = items.length ? `${listId}-${index}` : undefined;
  useEffect(() => {
    if (optionId) document.getElementById(optionId)?.scrollIntoView({ block: "nearest" });
  }, [optionId]);
  const pending = valid && allowed.length > 0 && (!ready || result.isFetching);
  const partial = groups?.some((group) => group.status !== "ok");
  const limited = groups?.some((group) => group.limited);
  const rawRequestId = result.isError
    ? isAppError(result.error)
      ? result.error.requestId
      : undefined
    : result.data?.request_id;
  const requestId =
    ready &&
    !result.isFetching &&
    rawRequestId &&
    /^[A-Za-z0-9_-]{1,128}$/.test(rawRequestId) &&
    !containsPotentialSecret(rawRequestId, auth.credentialPrefixes)
      ? rawRequestId
      : undefined;
  return (
    <>
      <ResourceSearchScope
        allowed={allowed}
        value={scope}
        onChange={(value) => {
          setScope(value);
          setActive(0);
          inputRef.current?.focus();
        }}
      />
      <p className="command-footer resource-search-help">
        종류별 최대 10개 · 이름 검색{kinds.includes("setting") ? " · 설정 키·범주·설명 검색" : ""}
        {kinds.includes("model") ? " · 모델 목록은 공급자 연결 상태에 따라 일부만 표시될 수 있습니다." : ""}
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
        {partial
          ? ` 일부 종류: ${groups
              ?.filter((group) => group.status !== "ok")
              .map(
                (group) =>
                  `${resourceSearchTargets[group.kind].title} (${group.status === "forbidden" ? "권한 없음" : group.status === "partial" ? "일부 목록만 확인됨" : "조회 실패"})`,
              )
              .join(", ")}.`
          : ""}
        {limited
          ? ` 더 구체적으로 검색: ${groups
              ?.filter((group) => group.limited)
              .map((group) => resourceSearchTargets[group.kind].title)
              .join(", ")}`
          : ""}
      </div>
      {ready && (result.isError || partial) ? (
        <div className="resource-search-recovery">
          <Button
            variant="secondary"
            disabled={result.isFetching}
            onClick={() => {
              inputRef.current?.focus();
              void result.refetch();
            }}
          >
            자원 검색 다시 시도
          </Button>
          {requestId ? <p>요청 ID: {requestId}</p> : null}
        </div>
      ) : null}
      <div
        id={listId}
        className="command-results"
        role="listbox"
        aria-label="자원 검색 결과"
        hidden={!items.length}
      >
        {kinds.map((kind) => {
          const positions = items
            .map((item, position) => ({ item, position }))
            .filter(({ item }) => item.kind === kind);
          if (!positions.length) return null;
          const labelId = `${listId}-group-${kind}`;
          return (
            <div key={kind} role="group" aria-labelledby={labelId}>
              <div id={labelId} className="resource-search-group-label">
                <strong>{resourceSearchTargets[kind].title}</strong>{" "}
                <span>
                  {positions.length}개
                  {groups?.some((group) => group.kind === kind && group.limited) ? " · 일부 결과" : ""}
                </span>
              </div>
              {positions.map(({ item, position }) => (
                <button
                  key={JSON.stringify([item.kind, item.server_label, item.provider_ref, item.id])}
                  id={`${listId}-${position}`}
                  type="button"
                  className="command-result resource-search-result"
                  role="option"
                  tabIndex={-1}
                  aria-selected={position === index}
                  onPointerMove={() => setActive(position)}
                  onClick={() => go(item.path)}
                >
                  <span>
                    <strong>{item.title}</strong>
                    <small>
                      {resourceSearchTargets[item.kind].title}
                      {item.kind === "model"
                        ? ` · ${item.provider_label}${item.virtual ? " · 가상 모델" : ""}`
                        : ""}
                      {item.kind === "setting" ? ` · ${item.id}` : ""}
                      {item.kind === "mcp_tool"
                        ? ` · ${item.server_label === "(none)" ? "서버 미지정" : item.server_label}`
                        : ""}
                    </small>
                  </span>
                  <span>자원</span>
                </button>
              ))}
            </div>
          );
        })}
      </div>
    </>
  );
}
