import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Link } from "react-router";

import { useRequestDetailReadScope } from "@/features/observability/request-insight/request-detail-read-scope";
import { useXViewReadOwner } from "@/features/observability/xview/xview-live-access";
import { apiClient } from "@/shared/api/client";
import { appRequestsContractHeaders } from "@/shared/api/app-request-contract";
import type { RequestIOCapture, RequestIOPreview } from "@/shared/api/domains/observability.schemas";
import { endpoints } from "@/shared/api/endpoints";
import { isAppError } from "@/shared/api/error";
import type { AppRequestSummary, AppRequestsQuery, AppRequestsResponse } from "@/shared/api/schemas";
import { PageHeader } from "@/shared/components/page/PageHeader";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { Select } from "@/shared/components/ui/Select";
import { Sheet } from "@/shared/components/ui/Sheet";
import { Switch } from "@/shared/components/ui/Switch";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { formatDuration, formatKRW, formatNumber, formatRelative } from "@/shared/utils/format";

import { inputSummary, outputSummary, requestStatusTone } from "./request-io-model";
import { RequestIOPanel } from "./RequestIOPanel";
import { useRequestIOPreviews } from "./use-request-io-previews";
import "@/features/observability/observability.css";
import "./request-io.css";

const routeId = "observability.io";
const liveIntervalMs = 3_000;
const pageSize = 30;
const wideLayoutQuery = "(min-width: 75.0625rem)";
const statusOptions = [
  { value: "", label: "전체" },
  { value: "success", label: "성공" },
  { value: "error", label: "오류" },
  { value: "4xx", label: "요청 오류 (4xx)" },
  { value: "5xx", label: "서버 오류 (5xx)" },
] as const;

function useWideLayout(): boolean {
  return useSyncExternalStore(
    (notify) => {
      const query = window.matchMedia(wideLayoutQuery);
      query.addEventListener("change", notify);
      return () => query.removeEventListener("change", notify);
    },
    () => window.matchMedia(wideLayoutQuery).matches,
  );
}

function timeOfDay(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "시각 미상";
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function RequestRow({
  active,
  onSelect,
  preview,
  previewPending,
  request,
}: {
  active: boolean;
  onSelect: () => void;
  preview: RequestIOPreview | undefined;
  previewPending: boolean;
  request: AppRequestSummary;
}): React.JSX.Element {
  const input = inputSummary(preview);
  const output = outputSummary(preview, request.status_code);
  const pendingText = previewPending ? "불러오는 중" : undefined;
  return (
    <li>
      <button
        type="button"
        className="io-row"
        aria-current={active ? "true" : undefined}
        data-request-id={request.request_id}
        onClick={onSelect}
      >
        <span className="io-row-meta">
          <Badge tone={requestStatusTone(request.status_code)}>{request.status_code}</Badge>
          <strong>{request.model || "모델 미상"}</strong>
          <span>{timeOfDay(request.created_at)}</span>
          <span>{formatDuration(request.latency_ms)}</span>
          <span>
            토큰 {formatNumber(request.prompt_tokens)} → {formatNumber(request.completion_tokens)}
          </span>
          <span>{formatKRW(request.estimated_cost)}</span>
        </span>
        <span className="io-row-line" data-tone={preview ? input.tone : "muted"}>
          <span>입력</span>
          <span>{pendingText ?? input.text}</span>
        </span>
        <span className="io-row-line" data-tone={preview ? output.tone : "muted"}>
          <span>출력</span>
          <span>{pendingText ?? output.text}</span>
        </span>
      </button>
    </li>
  );
}

function CaptureNotice({ capture }: { capture: RequestIOCapture | undefined }): React.JSX.Element | null {
  if (!capture || capture.response_text) return null;
  return (
    <InlineNotice
      tone="warning"
      title="응답 본문을 저장하지 않고 있어 출력이 비어 보입니다."
      actions={
        <Link
          className="button button-secondary button-small"
          to="/system/settings?tab=runtime&q=logging.response_text"
        >
          저장 설정 열기
        </Link>
      }
    >
      입력은 마스킹해 저장하지만 출력은 상태·종료 사유·도구 이름만 남습니다. 응답 본문
      저장(LOG_RESPONSE_TEXT)을 켜면 이후 요청부터 출력이 함께 저장됩니다.
    </InlineNotice>
  );
}

export function RequestIOPage(): React.JSX.Element {
  const owner = useXViewReadOwner(routeId);
  const scope = useRequestDetailReadScope(owner, owner.isCurrent);
  const wide = useWideLayout();
  const [params, updateParams] = useSearchState();
  const live = params.get("live") !== "off";
  const cursor = params.get("cursor") ?? "";
  const status = params.get("status") ?? "";
  const model = params.get("model") ?? "";
  const requestedId = params.get("request_id") ?? "";
  const [modelDraft, setModelDraft] = useState(model);
  const [search, setSearch] = useState("");

  const query = useMemo<AppRequestsQuery>(
    () => ({
      limit: pageSize,
      ...(status ? { status: status as AppRequestsQuery["status"] } : {}),
      ...(model ? { model } : {}),
      ...(cursor ? { cursor } : {}),
    }),
    [cursor, model, status],
  );
  const list = useQuery<AppRequestsResponse>({
    queryKey: ["observability", "io", "list", scope.id, query],
    enabled: owner.readable,
    gcTime: 0,
    refetchInterval: live && !cursor ? liveIntervalMs : false,
    refetchIntervalInBackground: false,
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[3] === scope.id ? previous : undefined,
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.admin.requests, {
        headers: appRequestsContractHeaders,
        query,
        signal,
        routeId,
      }),
  });
  const denied = isAppError(list.error) && (list.error.kind === "permission" || list.error.kind === "auth");
  const received = useMemo(() => (denied ? [] : (list.data?.requests ?? [])), [denied, list.data]);

  // While the operator scrolls older rows, new arrivals wait behind a button so the row they
  // are reading does not move under them.
  const listPane = useRef<HTMLDivElement>(null);
  const [held, setHeld] = useState<readonly AppRequestSummary[]>();
  const rows = held ?? received;
  const heldIds = useMemo(() => new Set(held?.map((row) => row.request_ref)), [held]);
  const newRowCount = held ? received.filter((row) => !heldIds.has(row.request_ref)).length : 0;
  const onListScroll = (): void => {
    const scrolled = (listPane.current?.scrollTop ?? 0) > 48;
    if (scrolled && !held) setHeld(received);
    else if (!scrolled && held) setHeld(undefined);
  };
  const showNewRows = (): void => {
    listPane.current?.scrollTo({ top: 0 });
    setHeld(undefined);
  };

  const filterableIds = useMemo(
    () => rows.filter((row) => row.request_filterable).map((row) => row.request_id),
    [rows],
  );
  const {
    previews,
    capture,
    failed: previewsFailed,
  } = useRequestIOPreviews(filterableIds, scope, owner.readable, routeId);

  const term = search.trim().toLowerCase();
  const visibleRows = useMemo(() => {
    if (!term) return rows;
    return rows.filter((row) => {
      const preview = previews.get(row.request_id);
      return [
        row.model,
        row.request_id,
        preview?.input.text,
        preview?.output.text,
        ...(preview?.output.tool_names ?? []),
      ]
        .join("\n")
        .toLowerCase()
        .includes(term);
    });
  }, [previews, rows, term]);

  const [firstRow, setFirstRow] = useState<string>();
  const firstFilterable = rows.find((row) => row.request_filterable)?.request_id;
  if (wide && firstRow === undefined && firstFilterable) setFirstRow(firstFilterable);
  const selectedId = requestedId || (wide ? (firstRow ?? "") : "");
  const select = (id: string): void => updateParams({ request_id: id }, { replace: true });

  const listRefs = useRef<HTMLUListElement>(null);
  const onRowKey = (event: React.KeyboardEvent<HTMLUListElement>): void => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const buttons = [...(listRefs.current?.querySelectorAll<HTMLButtonElement>("button.io-row") ?? [])];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    const next = buttons[index + (event.key === "ArrowDown" ? 1 : -1)];
    next?.focus();
    next?.click();
  };

  const refresh = (): void => {
    void list.refetch();
  };
  const mobileReturnFocus = useRef<HTMLElement | null>(null);

  return (
    <div className="page-stack io-page">
      <PageHeader
        title="입출력 모니터"
        description="게이트웨이를 지난 요청의 입력과 출력을 한눈에 봅니다. 목록의 내용은 역할과 관계없이 마스킹됩니다."
        legacyHref="/admin#/requests"
        actions={
          <>
            <Switch
              checked={live}
              label="실시간"
              onCheckedChange={(next) => updateParams({ live: next ? undefined : "off" })}
            />
            <Button onClick={refresh} disabled={list.isFetching && !list.isPlaceholderData}>
              <RefreshCw aria-hidden="true" /> 지금 새로고침
            </Button>
          </>
        }
      />

      <CaptureNotice capture={capture} />

      <form
        className="io-toolbar"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          updateParams({ model: modelDraft.trim() || undefined, cursor: undefined, request_id: undefined });
        }}
      >
        <label>
          결과
          <Select
            value={status}
            onChange={(event) =>
              updateParams({
                status: event.target.value || undefined,
                cursor: undefined,
                request_id: undefined,
              })
            }
            options={statusOptions.map((option) => ({ value: option.value, label: option.label }))}
          />
        </label>
        <label>
          모델
          <Input
            value={modelDraft}
            onChange={(event) => setModelDraft(event.target.value)}
            placeholder="gpt-4.1"
          />
        </label>
        <Button type="submit">적용</Button>
        <label className="io-search">
          표시된 요청에서 찾기
          <Input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="입력·출력 내용, 모델, 요청 ID"
          />
        </label>
      </form>

      {denied ? (
        <InlineNotice tone="danger" title="요청을 볼 권한을 확인할 수 없습니다.">
          이전 자료를 숨겼습니다. 다시 로그인한 뒤 새로고침해 주세요.
        </InlineNotice>
      ) : list.isError && rows.length === 0 ? (
        <InlineNotice
          tone="danger"
          title="요청 목록을 불러오지 못했습니다."
          actions={
            <Button size="small" onClick={refresh}>
              다시 시도
            </Button>
          }
        >
          {safeAppErrorMessage(list.error, "요청 목록을 불러오지 못했습니다.")}
          {isAppError(list.error) && list.error.requestId ? (
            <span className="request-id"> 요청 ID: {list.error.requestId}</span>
          ) : null}
        </InlineNotice>
      ) : null}
      {previewsFailed ? (
        <InlineNotice tone="warning" title="입출력 미리보기를 불러오지 못했습니다.">
          목록은 계속 갱신합니다. 요청을 선택하면 전체 내용을 다시 불러옵니다.
        </InlineNotice>
      ) : null}

      <div className="io-workspace">
        <div
          ref={listPane}
          className="io-list-pane"
          tabIndex={-1}
          onScroll={onListScroll}
          aria-busy={list.isPending}
        >
          {newRowCount > 0 ? (
            <div className="io-new-rows">
              <Button size="small" variant="primary" onClick={showNewRows}>
                새 요청 {formatNumber(newRowCount)}건 보기
              </Button>
            </div>
          ) : null}
          {list.isPending && owner.readable ? (
            <div className="io-group-body" role="status" aria-live="polite">
              요청을 불러오는 중입니다.
            </div>
          ) : visibleRows.length === 0 && !denied ? (
            <EmptyState
              title={term ? "찾는 내용이 있는 요청이 없습니다." : "표시할 요청이 없습니다."}
              description={
                term
                  ? "지금 표시된 요청 안에서만 찾습니다. 필터를 조정하거나 다음 페이지에서 찾아보세요."
                  : "게이트웨이로 요청이 들어오면 여기에 입력과 출력이 나타납니다."
              }
            />
          ) : (
            <ul ref={listRefs} className="io-list" aria-label="요청 입출력 목록" onKeyDown={onRowKey}>
              {visibleRows.map((row) => (
                <RequestRow
                  key={row.request_ref}
                  active={row.request_id === selectedId}
                  onSelect={() => {
                    if (row.request_filterable) select(row.request_id);
                  }}
                  preview={previews.get(row.request_id) ?? undefined}
                  previewPending={row.request_filterable && !previews.has(row.request_id) && !previewsFailed}
                  request={row}
                />
              ))}
            </ul>
          )}
        </div>

        {wide ? (
          <div className="io-detail-pane" aria-label="선택한 요청의 입력과 출력" role="region">
            <h2 className="sr-only">선택한 요청의 입력과 출력</h2>
            {selectedId && !denied ? (
              <RequestIOPanel requestId={selectedId} readScope={scope} />
            ) : (
              <EmptyState
                title="요청을 선택하세요."
                description="왼쪽 목록에서 요청을 고르면 입력과 출력을 나란히 보여 줍니다."
              />
            )}
          </div>
        ) : null}
      </div>

      {!wide ? (
        <Sheet
          open={selectedId !== "" && !denied}
          onOpenChange={(next) => {
            if (!next) updateParams({ request_id: undefined });
          }}
          returnFocusRef={mobileReturnFocus}
          size="wide"
          title="요청 입력과 출력"
          description="목록의 미리보기와 달리 메시지 전체를 보여 줍니다."
        >
          {selectedId ? <RequestIOPanel requestId={selectedId} readScope={scope} /> : null}
        </Sheet>
      ) : null}

      <div className="io-pager">
        <p className="obs-meta" role="status">
          {live && !cursor
            ? `약 ${liveIntervalMs / 1000}초 간격으로 새 요청을 조회합니다.`
            : cursor
              ? "이전 페이지를 보는 동안에는 자동 조회를 멈춥니다."
              : "실시간 꺼짐"}{" "}
          {list.dataUpdatedAt > 0 ? `마지막 응답 확인 ${formatRelative(list.dataUpdatedAt)}` : ""}
        </p>
        <div className="io-row-meta">
          {list.data?.previous_cursor ? (
            <Button
              size="small"
              onClick={() => updateParams({ cursor: list.data?.previous_cursor, request_id: undefined })}
            >
              새로운 요청
            </Button>
          ) : null}
          {cursor ? (
            <Button size="small" onClick={() => updateParams({ cursor: undefined, request_id: undefined })}>
              최신으로
            </Button>
          ) : null}
          {list.data?.next_cursor ? (
            <Button
              size="small"
              onClick={() => updateParams({ cursor: list.data?.next_cursor, request_id: undefined })}
            >
              이전 요청
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
