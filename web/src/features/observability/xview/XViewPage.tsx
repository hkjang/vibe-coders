import { RequestNoteBoundary } from "@/features/observability/request-insight/RequestNoteBoundary";
import { useRequestNoteContext } from "@/features/observability/request-insight/request-note-context";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  canInspectRawRequest,
  canWriteRequestNote,
} from "@/features/observability/request-insight/request-access";
import { RequestInsightPanel } from "@/features/observability/request-insight/RequestInsightPanel";
import { ModelAggregatePanel } from "@/features/observability/xview/ModelAggregatePanel";
import { SavedViewBar } from "@/features/observability/xview/SavedViewBar";
import { savedViewParamKeys } from "@/features/observability/xview/saved-view-params";
import { ScatterPlot } from "@/features/observability/xview/ScatterPlot";
import {
  metricValue,
  pointCategory,
  scatterMetrics,
  scatterViewModes,
  type ScatterMetric,
  type ScatterScale,
  type ScatterViewMode,
} from "@/features/observability/xview/scatter-model";
import { WaterfallPanel } from "@/features/observability/xview/WaterfallPanel";
import {
  useXViewLive,
  xviewDeniedMessage,
  type XViewFilters,
} from "@/features/observability/xview/use-xview-live";
import { useXViewReadOwner, type XViewReadOwner } from "./xview-live-access";
import { summarizeXView } from "./xview-live-state";
import { XViewLiveStatus } from "./XViewLiveStatus";
import { useAuth } from "@/app/auth/AuthProvider";
import { apiClient } from "@/shared/api/client";
import type { ScatterPoint } from "@/shared/api/domains/observability.schemas";
import { endpoints } from "@/shared/api/endpoints";
import { isAppError } from "@/shared/api/error";
import { PageHeader } from "@/shared/components/page/PageHeader";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { Sheet } from "@/shared/components/ui/Sheet";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { Switch } from "@/shared/components/ui/Switch";
import { TabPanel, Tabs } from "@/shared/components/ui/Tabs";
import { Toolbar } from "@/shared/components/ui/Toolbar";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { useTabParam } from "@/shared/hooks/use-tab-param";
import { containsPotentialSecret, secretSearchMessage } from "@/shared/security/secrets";
import { formatDateTime, formatKRW, formatNumber } from "@/shared/utils/format";
import "@/features/observability/observability.css";
import "./xview-live.css";

const tabIds = ["scatter", "models", "waterfall"] as const;
type TabId = (typeof tabIds)[number];

const windows = ["5m", "15m", "1h", "6h", "24h"] as const;
const timeZones = [
  "Asia/Seoul",
  "UTC",
  "America/Los_Angeles",
  "America/New_York",
  "Europe/London",
  "Asia/Tokyo",
];
const defaultWindow = "1h";
const defaultTimeZone = "Asia/Seoul";

function pick<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly string[]).includes(value ?? "") ? (value as T) : fallback;
}

export function XViewPage(): React.JSX.Element {
  const principal = useXViewReadOwner();
  const suspended = useRef<XViewReadOwner | undefined>(undefined);
  const readOwner = useMemo(
    () => ({
      ...principal,
      onDenied: () => {
        suspended.current = principal;
      },
      resumeDraft: () => {
        if (principal.isCurrent()) suspended.current = undefined;
      },
    }),
    [principal],
  );
  const retainDraft = useMemo(
    () => ({
      owner: readOwner,
      isCurrent: readOwner.isCurrent,
      isSuspended: () => suspended.current === principal,
    }),
    [principal, readOwner],
  );
  return (
    <RequestNoteBoundary retainDraft={retainDraft}>
      <XViewPageContent readOwner={readOwner} />
    </RequestNoteBoundary>
  );
}

function XViewPageContent({ readOwner }: { readOwner: XViewReadOwner }): React.JSX.Element {
  const noteEditor = useRequestNoteContext();
  const auth = useAuth();
  const [params, updateParams] = useSearchState();
  const [tab, setTab] = useTabParam<TabId>(tabIds);
  const canWrite = auth.mode !== "authenticated" || (auth.user?.scopes.includes("admin:write") ?? false);
  const writeDeniedReason = "저장된 뷰 관리에는 admin:write 권한이 필요합니다.";

  const window_ = pick(params.get("window"), windows, defaultWindow);
  const metric = pick(
    params.get("metric"),
    scatterMetrics.map((item) => item.value),
    "latency",
  ) as ScatterMetric;
  const scale = pick(params.get("scale"), ["log", "linear"] as const, "log") as ScatterScale;
  const viewMode = pick(
    params.get("viewMode"),
    scatterViewModes.map((item) => item.value),
    "category",
  ) as ScatterViewMode;
  const timeZone = pick(params.get("tz"), timeZones, defaultTimeZone);
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";
  const models = params.get("models") ?? "";
  const endpoint = params.get("endpoint") ?? "";
  const live = params.get("live") !== "off";
  const savedViewId = params.get("view") ?? "";
  const sessionId = params.get("session_id") ?? "";

  const filters = useMemo<XViewFilters>(() => {
    const next: XViewFilters = { tz: timeZone };
    if (from || to) {
      if (from) next.from = from;
      if (to) next.to = to;
    } else {
      next.window = window_;
    }
    if (models) next.models = models;
    if (endpoint) next.endpoint = endpoint;
    return next;
  }, [endpoint, from, models, timeZone, to, window_]);

  const [draft, setDraft] = useState({ from, to, models, endpoint });
  const [filterError, setFilterError] = useState<string>();
  const live_ = useXViewLive(filters, live && tab === "scatter", readOwner);
  const displayOwner = useMemo(
    () => ({ readOwner, retirement: live_.denialBoundary }),
    [readOwner, live_.denialBoundary],
  );
  const [selected, setSelected] = useState<{ owner: object; points: ReadonlyArray<ScatterPoint> }>();
  const [flow, setFlow] = useState<{ owner: object; id: string }>();
  const [insight, setInsight] = useState<{ owner: object; id: string }>();
  const selection = selected?.owner === displayOwner ? selected.points : [];
  const flowRequestId = flow?.owner === displayOwner ? flow.id : "";
  const insightRequestId = insight?.owner === displayOwner ? insight.id : "";
  const noteRequestId =
    insight?.owner === displayOwner ? (noteEditor.target?.requestId ?? insightRequestId) : "";
  const setSelection = (points: ReadonlyArray<ScatterPoint>) => setSelected({ owner: displayOwner, points });
  const setFlowRequestId = (id: string) => setFlow({ owner: displayOwner, id });
  const setInsightRequestId = (id: string) => setInsight({ owner: displayOwner, id });
  const selectionFocusRef = useRef<HTMLElement | null>(null);
  const flowFocusRef = useRef<HTMLElement | null>(null);
  const insightFocusRef = useRef<HTMLElement | null>(null);
  const refreshFocusRef = useRef<HTMLButtonElement | null>(null);
  useLayoutEffect(() => {
    if ((selected && selected.owner !== displayOwner) || live_.points.length === 0)
      selectionFocusRef.current = refreshFocusRef.current;
    if (flow && flow.owner !== displayOwner) flowFocusRef.current = refreshFocusRef.current;
    if (insight && insight.owner !== displayOwner) insightFocusRef.current = refreshFocusRef.current;
  }, [displayOwner, flow, insight, live_.points.length, selected]);
  const canInspectRaw = canInspectRawRequest(auth);
  const canWriteNote = canWriteRequestNote(auth);

  const flowMap = useQuery({
    queryKey: ["observability", "xview", "flow-map", flowRequestId, live_.lifetime.id],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.observability.xview.flowMap, {
        query: { request_id: flowRequestId },
        signal,
        routeId: "observability.xview.flow-map",
      }),
    enabled: flowRequestId !== "",
    gcTime: 0,
    staleTime: 30_000,
  });

  const signals = useMemo(() => summarizeXView(live_.points), [live_.points]);
  const scatterPlot = useMemo(
    () => (
      <ScatterPlot
        points={live_.points}
        metric={metric}
        scale={scale}
        viewMode={viewMode}
        onSelect={(points) => setSelected({ owner: displayOwner, points })}
      />
    ),
    [displayOwner, live_.points, metric, scale, viewMode],
  );

  const currentSavedParams = useMemo(() => {
    const search = new URLSearchParams();
    const values: Record<string, string> = {
      window: from || to ? "" : window_,
      metric,
      scale,
      viewMode,
      from,
      to,
      tz: timeZone,
      models,
      endpoint,
    };
    for (const key of savedViewParamKeys) {
      const value = values[key];
      if (value) search.set(key, value);
    }
    return search.toString();
  }, [endpoint, from, metric, models, scale, timeZone, to, viewMode, window_]);

  const applySavedView = (rawParams: string, id: string): void => {
    const parsed = new URLSearchParams(rawParams);
    const updates: Record<string, string | undefined> = { view: id || undefined };
    for (const key of savedViewParamKeys) updates[key] = parsed.get(key) ?? undefined;
    setDraft({
      from: parsed.get("from") ?? "",
      to: parsed.get("to") ?? "",
      models: parsed.get("models") ?? "",
      endpoint: parsed.get("endpoint") ?? "",
    });
    updateParams(updates);
  };

  const applyFilters = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (containsPotentialSecret(draft.models) || containsPotentialSecret(draft.endpoint)) {
      setFilterError(secretSearchMessage);
      return;
    }
    setFilterError(undefined);
    updateParams({
      from: draft.from || undefined,
      to: draft.to || undefined,
      models: draft.models.trim() || undefined,
      endpoint: draft.endpoint.trim() || undefined,
      view: undefined,
    });
  };

  const resetFilters = (): void => {
    setDraft({ from: "", to: "", models: "", endpoint: "" });
    setFilterError(undefined);
    updateParams({
      from: undefined,
      to: undefined,
      models: undefined,
      endpoint: undefined,
      window: undefined,
      metric: undefined,
      scale: undefined,
      viewMode: undefined,
      tz: undefined,
      view: undefined,
    });
  };

  return (
    <div className="page-stack xview-live-page">
      <PageHeader
        title="XView 실시간"
        description="최근 요청의 분포와 이상치를 실시간 산점도로 관찰하고, 원인 세션까지 따라갑니다."
        legacyHref="/admin#/xview"
        actions={
          <>
            <Switch
              checked={live}
              label="실시간"
              onCheckedChange={(next) => updateParams({ live: next ? undefined : "off" })}
            />
            <Button ref={refreshFocusRef} onClick={live_.refresh}>
              <RefreshCw aria-hidden="true" /> 지금 새로고침
            </Button>
          </>
        }
      />

      <XViewLiveStatus state={live_} live={live} scatter={tab === "scatter"} fixedEnd={Boolean(to)} />

      <SavedViewBar
        canWrite={canWrite}
        currentParams={currentSavedParams}
        onApply={applySavedView}
        selectedId={savedViewId}
        writeDeniedReason={writeDeniedReason}
      />

      <form onSubmit={applyFilters}>
        <Toolbar
          label="XView 필터"
          end={
            <>
              <Button type="submit" variant="primary">
                필터 적용
              </Button>
              <Button type="button" onClick={resetFilters}>
                초기화
              </Button>
            </>
          }
        >
          <label>
            상대 조회 구간
            <Select
              value={from || to ? "" : window_}
              onChange={(event) =>
                updateParams({
                  window: event.target.value === defaultWindow ? undefined : event.target.value,
                  from: undefined,
                  to: undefined,
                })
              }
              options={[
                { value: "5m", label: "최근 5분" },
                { value: "15m", label: "최근 15분" },
                { value: "1h", label: "최근 1시간" },
                { value: "6h", label: "최근 6시간" },
                { value: "24h", label: "최근 24시간" },
              ]}
            >
              {from || to ? <option value="">직접 지정</option> : null}
            </Select>
          </label>
          <label>
            시작 일시
            <Input
              type="datetime-local"
              value={draft.from}
              onChange={(event) => setDraft((current) => ({ ...current, from: event.target.value }))}
            />
          </label>
          <label>
            종료 일시
            <Input
              type="datetime-local"
              value={draft.to}
              onChange={(event) => setDraft((current) => ({ ...current, to: event.target.value }))}
            />
          </label>
          <label>
            검색 시간대
            <Select
              value={timeZone}
              onChange={(event) =>
                updateParams({
                  tz: event.target.value === defaultTimeZone ? undefined : event.target.value,
                })
              }
              options={timeZones.map((zone) => ({ value: zone, label: zone }))}
            />
          </label>
          <label>
            세로축 지표
            <Select
              value={metric}
              onChange={(event) =>
                updateParams({ metric: event.target.value === "latency" ? undefined : event.target.value })
              }
              options={scatterMetrics.map((item) => ({ value: item.value, label: item.label }))}
            />
          </label>
          <label>
            축 스케일
            <Select
              value={scale}
              onChange={(event) =>
                updateParams({ scale: event.target.value === "log" ? undefined : event.target.value })
              }
              options={[
                { value: "log", label: "로그" },
                { value: "linear", label: "선형" },
              ]}
            />
          </label>
          <label>
            점 구분 방식
            <Select
              value={viewMode}
              onChange={(event) =>
                updateParams({
                  viewMode: event.target.value === "category" ? undefined : event.target.value,
                })
              }
              options={scatterViewModes.map((item) => ({ value: item.value, label: item.label }))}
            />
          </label>
          <label>
            모델 (쉼표 구분)
            <Input
              value={draft.models}
              onChange={(event) => setDraft((current) => ({ ...current, models: event.target.value }))}
              placeholder="gpt-4.1,gpt-4.1-mini"
            />
          </label>
          <label>
            엔드포인트
            <Input
              value={draft.endpoint}
              onChange={(event) => setDraft((current) => ({ ...current, endpoint: event.target.value }))}
              placeholder="/v1/chat/completions"
            />
          </label>
        </Toolbar>
      </form>
      {filterError ? (
        <p className="form-error" role="alert">
          {filterError}
        </p>
      ) : null}

      {live_.initialError ? (
        <InlineNotice tone="danger" title="요청 분포를 불러오지 못했습니다.">
          {live_.denied
            ? xviewDeniedMessage
            : safeAppErrorMessage(live_.initialError, "요청 분포를 불러오지 못했습니다.")}
          {isAppError(live_.initialError) && live_.initialError.requestId ? (
            <span className="request-id"> 요청 ID: {live_.initialError.requestId}</span>
          ) : null}
        </InlineNotice>
      ) : null}

      <StatGrid label="지금 확인할 신호">
        <StatCard label="분석 요청" value={formatNumber(signals.total)} />
        <StatCard
          label="오류"
          value={formatNumber(signals.errors)}
          tone={signals.errors > 0 ? "danger" : "default"}
        />
        <StatCard
          label="폴백"
          value={formatNumber(signals.fallbacks)}
          tone={signals.fallbacks > 0 ? "warning" : "default"}
        />
        <StatCard label="정책 신호" value={formatNumber(signals.governance)} tone="info" />
        <StatCard label="지연 P95" value={`${formatNumber(signals.p95)}ms`} />
      </StatGrid>

      <p className="obs-meta">
        요약은 현재 표시한 요청 점 기준입니다. 조회와 주기적 보완은 전체 요청의 누락 없는 수집을 보장하지
        않습니다.
      </p>
      {live_.truncated ? (
        <InlineNotice tone="warning" title="표본이 상한에 걸렸습니다.">
          조회 구간의 요청이 6,000건 상한을 넘어 최근 구간만 표시합니다. 구간을 좁혀 다시 확인하세요.
        </InlineNotice>
      ) : null}
      {live_.liveError ? (
        <InlineNotice
          tone="warning"
          title="실시간 갱신이 지연되고 있습니다."
          actions={
            <Button size="small" onClick={live_.refresh}>
              지금 재시도
            </Button>
          }
        >
          {live_.liveError} 마지막으로 받은 데이터를 계속 표시합니다.
        </InlineNotice>
      ) : null}

      <Tabs
        ariaLabel="XView 화면"
        panelIdPrefix="xview"
        items={[
          { id: "scatter", label: "실시간 산점도" },
          { id: "models", label: "모델 집계" },
          { id: "waterfall", label: "세션 워터폴" },
        ]}
        value={tab}
        onChange={setTab}
      />

      <TabPanel id={tab} panelIdPrefix="xview">
        {tab === "scatter" ? (
          <SectionCard
            className="xview-distribution-card"
            title="요청 분포"
            description="가로축은 시간, 세로축은 선택한 지표입니다. 그래프를 드래그하면 그 구간의 요청이 선택됩니다."
            actions={
              <Button
                size="small"
                disabled={live_.points.length === 0}
                onClick={(event) => {
                  selectionFocusRef.current = event.currentTarget;
                  setSelection(live_.points.slice(-25).reverse());
                }}
              >
                최근 25건 선택
              </Button>
            }
          >
            {live_.initialPending ? (
              <div role="status" aria-live="polite">
                요청 분포를 불러오는 중입니다.
              </div>
            ) : live_.points.length === 0 ? (
              <EmptyState
                title="표시할 요청이 없습니다."
                description="현재 받은 자료에 표시할 요청 점이 없습니다. 조회 상태를 확인하거나 구간·모델·엔드포인트 필터를 조정해 보세요."
                actions={<Button onClick={resetFilters}>필터 초기화</Button>}
              />
            ) : (
              scatterPlot
            )}
          </SectionCard>
        ) : null}

        {tab === "models" ? <ModelAggregatePanel filters={filters} /> : null}

        {tab === "waterfall" ? (
          <WaterfallPanel
            sessionId={sessionId}
            onSessionChange={(next) => updateParams({ session_id: next || undefined })}
          />
        ) : null}
      </TabPanel>

      <Sheet
        open={selection.length > 0}
        onOpenChange={(next) => {
          if (!next) setSelection([]);
        }}
        returnFocusRef={selectionFocusRef}
        size="wide"
        title={`선택한 요청 ${formatNumber(selection.length)}건`}
        description="선택 구간의 요청 목록입니다. 처리 흐름을 열어 어느 단계에서 시간이 들었는지 확인하세요."
      >
        <div className="data-table-scroll" tabIndex={0} aria-label="선택한 요청 표 영역">
          <table className="data-table">
            <caption className="sr-only">산점도에서 선택한 요청</caption>
            <thead>
              <tr>
                <th scope="col">시각</th>
                <th scope="col">요청 ID</th>
                <th scope="col">모델</th>
                <th scope="col">상태</th>
                <th scope="col">지표</th>
                <th scope="col">비용</th>
                <th scope="col">작업</th>
              </tr>
            </thead>
            <tbody>
              {selection.map((point, index) => (
                <tr key={`${point.request_id}-${index}`}>
                  <th scope="row">{formatDateTime(point.created_at)}</th>
                  <td className="mono truncate">{point.request_id}</td>
                  <td>{point.model || "(미상)"}</td>
                  <td>
                    <Badge
                      tone={
                        pointCategory(point) === "error"
                          ? "danger"
                          : pointCategory(point) === "fallback"
                            ? "warning"
                            : pointCategory(point) === "governance"
                              ? "info"
                              : "success"
                      }
                    >
                      HTTP {formatNumber(point.status_code)}
                    </Badge>
                  </td>
                  <td className="cell-number">{formatNumber(metricValue(point, metric))}</td>
                  <td className="cell-number">{formatKRW(point.cost_krw)}</td>
                  <td>
                    <div className="obs-row-actions">
                      <Button
                        size="small"
                        onClick={(event) => {
                          flowFocusRef.current = event.currentTarget;
                          setFlowRequestId(point.request_id);
                        }}
                        aria-label={`${point.request_id} 처리 흐름 열기`}
                      >
                        처리 흐름
                      </Button>
                      <Button
                        size="small"
                        onClick={(event) => {
                          const trigger = event.currentTarget;
                          if (
                            noteEditor.retainedDraft?.target.requestId === point.request_id &&
                            noteEditor.target?.retention?.owner === readOwner &&
                            readOwner.isCurrent() &&
                            !live_.denied &&
                            !live_.initialError &&
                            !live_.snapshotFetching &&
                            !live_.snapshotInvalidated &&
                            live_.points.some((current) => current.request_id === point.request_id)
                          ) {
                            // Only an explicit same-request action can restore the retired sheet.
                            readOwner.resumeDraft?.();
                            insightFocusRef.current = trigger;
                            setInsightRequestId(point.request_id);
                          }
                          noteEditor.requestLeave(() => {
                            insightFocusRef.current = trigger;
                            setInsightRequestId(point.request_id);
                          });
                        }}
                        aria-label={`${point.request_id} 원인 설명 열기`}
                      >
                        원인 설명
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Sheet>

      <Sheet
        open={flowRequestId !== ""}
        onOpenChange={(next) => {
          if (!next) setFlowRequestId("");
        }}
        returnFocusRef={flowFocusRef}
        size="wide"
        title="처리 흐름"
        description="저장된 메타데이터로 재구성한 단계별 처리 결과입니다. 프롬프트와 SQL 원문은 포함되지 않습니다."
      >
        {flowMap.isPending && flowRequestId ? (
          <div role="status" aria-live="polite">
            처리 흐름을 불러오는 중입니다.
          </div>
        ) : null}
        {flowMap.isError ? (
          <InlineNotice tone="danger" title="처리 흐름을 불러오지 못했습니다.">
            {safeAppErrorMessage(flowMap.error, "처리 흐름을 불러오지 못했습니다.")}
            {isAppError(flowMap.error) && flowMap.error.requestId ? (
              <span className="request-id"> 요청 ID: {flowMap.error.requestId}</span>
            ) : null}
          </InlineNotice>
        ) : null}
        {flowMap.data ? (
          <div className="obs-section-stack">
            <KeyValueList
              items={[
                { label: "요청 ID", value: flowMap.data.request_id, mono: true },
                { label: "모델", value: flowMap.data.summary.model },
                { label: "공급자", value: flowMap.data.summary.provider },
                { label: "상태", value: `HTTP ${formatNumber(flowMap.data.summary.status_code)}` },
                { label: "지연", value: `${formatNumber(flowMap.data.summary.latency_ms)}ms` },
                { label: "발생 시각", value: formatDateTime(flowMap.data.summary.created_at) },
              ]}
            />
            <ol className="obs-timeline">
              {flowMap.data.stages.map((stage, index) => (
                <li key={`${stage.stage}-${index}`} className="obs-timeline-item">
                  <div className="obs-timeline-when">
                    <Badge
                      tone={
                        stage.status === "blocked" || stage.status === "error"
                          ? "danger"
                          : stage.status === "warn" || stage.status === "fallback"
                            ? "warning"
                            : stage.status === "skip"
                              ? "muted"
                              : "success"
                      }
                    >
                      {stage.status}
                    </Badge>
                  </div>
                  <div className="obs-timeline-body">
                    <strong>{stage.stage}</strong>
                    <div>{stage.decision || "—"}</div>
                    {stage.reason ? <div className="obs-meta">{stage.reason}</div> : null}
                  </div>
                </li>
              ))}
            </ol>
            {flowMap.data.note ? <p className="obs-meta">{flowMap.data.note}</p> : null}
          </div>
        ) : null}
      </Sheet>

      <Sheet
        open={noteRequestId !== "" && !(noteEditor.retainedDraft && noteEditor.awaitingParentDecision)}
        onOpenChange={(next) => {
          if (!next) noteEditor.requestLeave(() => setInsightRequestId(""));
        }}
        returnFocusRef={insightFocusRef}
        size="wide"
        title="요청 원인 설명"
        description="라우팅·폴백·캐시·안전장치·비용을 나눠 설명하고, 메모·분석·재실행을 이어서 처리합니다."
      >
        {noteRequestId ? (
          <RequestInsightPanel
            key={noteRequestId}
            requestId={noteRequestId}
            canInspectRaw={canInspectRaw}
            canWriteNote={canWriteNote}
          />
        ) : null}
      </Sheet>
    </div>
  );
}
