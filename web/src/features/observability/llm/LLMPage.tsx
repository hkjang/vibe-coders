import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageSquarePlus, RefreshCw, Search } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { z } from "zod";

import { TimeSeriesChart, type ChartSeries } from "@/features/observability/charts";
import { LLMTraceDetail } from "@/features/observability/llm/LLMTraceDetail";
import { PromptCompareDialog } from "@/features/observability/llm/PromptCompareDialog";
import { useAuth } from "@/app/auth/AuthProvider";
import { apiClient } from "@/shared/api/client";
import type { LLMScopeQuery } from "@/shared/api/domains/observability";
import { endpoints } from "@/shared/api/endpoints";
import { isAppError } from "@/shared/api/error";
import { FormDialog } from "@/shared/components/form/FormDialog";
import { FormField } from "@/shared/components/form/FormField";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { PageHeader } from "@/shared/components/page/PageHeader";
import { ErrorState } from "@/shared/components/state/PageStates";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { Sheet } from "@/shared/components/ui/Sheet";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { TabPanel, Tabs } from "@/shared/components/ui/Tabs";
import { Textarea } from "@/shared/components/ui/Textarea";
import { Toolbar } from "@/shared/components/ui/Toolbar";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { useRefreshInterval } from "@/shared/hooks/use-refresh-interval";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { useTabParam } from "@/shared/hooks/use-tab-param";
import { containsPotentialSecret, secretSearchMessage } from "@/shared/security/secrets";
import { formatDateTime, formatKRW, formatNumber, formatPercent } from "@/shared/utils/format";
import "@/features/observability/observability.css";

const tabIds = ["summary", "evaluations", "feedback", "prompts", "insights"] as const;
type TabId = (typeof tabIds)[number];

const windows = ["24h", "7d", "30d"] as const;
const defaultWindow = "24h";

const scopeKeys = [
  "api_key_id",
  "team",
  "model",
  "session_id",
  "prompt_name",
  "prompt_version",
  "evaluation_name",
] as const;

const feedbackSchema = z.object({
  request_id: z.string().trim().min(1, "요청 ID를 입력하세요."),
  rating: z.coerce.number().int().min(-1).max(1),
  label: z.string().trim().max(64).optional(),
  comment: z.string().trim().max(1000).optional(),
});
type FeedbackInput = z.input<typeof feedbackSchema>;
type FeedbackOutput = z.output<typeof feedbackSchema>;

function severityTone(severity: string): "danger" | "info" | "warning" {
  if (severity === "critical" || severity === "high") return "danger";
  if (severity === "medium" || severity === "warning") return "warning";
  return "info";
}

export function LLMPage(): React.JSX.Element {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const interval = useRefreshInterval();
  const [params, updateParams] = useSearchState();
  const [tab, setTab] = useTabParam<TabId>(tabIds);
  const canWrite = auth.mode !== "authenticated" || (auth.user?.scopes.includes("admin:write") ?? false);
  const writeDeniedReason = "피드백 등록에는 admin:write 권한이 필요합니다.";

  const rawWindow = params.get("window") ?? "";
  const activeWindow = (windows as readonly string[]).includes(rawWindow)
    ? (rawWindow as (typeof windows)[number])
    : defaultWindow;

  const scope = useMemo<LLMScopeQuery>(() => {
    const next: LLMScopeQuery = { window: activeWindow };
    for (const key of scopeKeys) {
      const value = params.get(key)?.trim();
      if (value) Object.assign(next, { [key]: value });
    }
    return next;
  }, [activeWindow, params]);

  const [filterDraft, setFilterDraft] = useState(() => ({
    api_key_id: params.get("api_key_id") ?? "",
    team: params.get("team") ?? "",
    model: params.get("model") ?? "",
  }));
  const [filterError, setFilterError] = useState<string>();
  const [selectedRequestId, setSelectedRequestId] = useState("");
  const [feedbackTarget, setFeedbackTarget] = useState<{ requestId: string; traceId: string }>();
  const [comparePrompt, setComparePrompt] = useState<{ name: string; version: string }>();
  const detailFocusRef = useRef<HTMLElement | null>(null);
  const feedbackFocusRef = useRef<HTMLElement | null>(null);
  const compareFocusRef = useRef<HTMLElement | null>(null);

  const commonQuery = { refetchInterval: interval, refetchIntervalInBackground: false } as const;

  const timeseries = useQuery({
    queryKey: ["observability", "llm", "timeseries", scope],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.observability.llm.timeseries, {
        query: { ...scope, bucket: activeWindow === "24h" ? "hour" : "day" },
        signal,
        routeId: "observability.llm.timeseries",
      }),
    placeholderData: keepPreviousData,
    ...commonQuery,
  });
  const evaluations = useQuery({
    queryKey: ["observability", "llm", "evaluations", scope],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.observability.llm.evaluations, {
        query: { ...scope, limit: 100 },
        signal,
        routeId: "observability.llm.evaluations",
      }),
    placeholderData: keepPreviousData,
    ...commonQuery,
  });
  const feedback = useQuery({
    queryKey: ["observability", "llm", "feedback", scope],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.observability.llm.feedback, {
        query: { ...scope, limit: 50 },
        signal,
        routeId: "observability.llm.feedback",
      }),
    placeholderData: keepPreviousData,
    ...commonQuery,
  });
  const prompts = useQuery({
    queryKey: ["observability", "llm", "prompts", scope],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.observability.llm.prompts, {
        query: { ...scope, limit: 100 },
        signal,
        routeId: "observability.llm.prompts",
      }),
    placeholderData: keepPreviousData,
    enabled: tab === "prompts" || tab === "summary",
    ...commonQuery,
  });
  const insights = useQuery({
    queryKey: ["observability", "llm", "insights", scope],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.observability.llm.insights, {
        query: { ...scope, limit: 50 },
        signal,
        routeId: "observability.llm.insights",
      }),
    placeholderData: keepPreviousData,
    enabled: tab === "insights" || tab === "summary",
    ...commonQuery,
  });
  const patterns = useQuery({
    queryKey: ["observability", "llm", "patterns", scope],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.observability.llm.patterns, {
        query: { ...scope, limit: 50 },
        signal,
        routeId: "observability.llm.patterns",
      }),
    placeholderData: keepPreviousData,
    enabled: tab === "insights",
    ...commonQuery,
  });

  const feedbackForm = useZodForm<FeedbackInput, FeedbackOutput>(feedbackSchema, {
    request_id: "",
    rating: 1,
    label: "",
    comment: "",
  });

  const submitFeedback = useMutationFeedback<FeedbackOutput, unknown>({
    mutate: (values) =>
      apiClient.request(endpoints.domains.observability.llm.submitFeedback, {
        body: {
          request_id: values.request_id,
          rating: values.rating,
          ...(feedbackTarget?.traceId ? { trace_id: feedbackTarget.traceId } : {}),
          ...(values.label ? { label: values.label } : {}),
          ...(values.comment ? { comment: values.comment } : {}),
          source: "console",
        },
        routeId: "observability.llm.feedback.create",
      }),
    invalidates: [
      ["observability", "llm", "feedback"],
      ["observability", "llm", "trace"],
    ],
    successMessage: "피드백을 등록했습니다.",
    errorMessage: "피드백을 등록하지 못했습니다.",
  });

  const openFeedback = (requestId: string, traceId: string, trigger?: HTMLElement): void => {
    if (!canWrite) return;
    feedbackFocusRef.current = trigger ?? null;
    setFeedbackTarget({ requestId, traceId });
    feedbackForm.reset({ request_id: requestId, rating: 1, label: "", comment: "" });
  };

  const applyFilters = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const values = Object.values(filterDraft);
    if (values.some((value) => containsPotentialSecret(value))) {
      setFilterError(secretSearchMessage);
      return;
    }
    setFilterError(undefined);
    updateParams({
      api_key_id: filterDraft.api_key_id.trim() || undefined,
      team: filterDraft.team.trim() || undefined,
      model: filterDraft.model.trim() || undefined,
    });
  };

  const resetFilters = (): void => {
    setFilterDraft({ api_key_id: "", team: "", model: "" });
    setFilterError(undefined);
    updateParams({
      api_key_id: undefined,
      team: undefined,
      model: undefined,
      session_id: undefined,
      prompt_name: undefined,
      prompt_version: undefined,
      evaluation_name: undefined,
    });
  };

  const refreshAll = (): void => {
    void queryClient.invalidateQueries({ queryKey: ["observability", "llm"] });
  };

  const points = timeseries.data?.points ?? [];
  const volumeSeries: ReadonlyArray<ChartSeries> = [
    {
      id: "requests",
      name: "요청",
      colorVar: "--obs-series-1",
      points: points.map((point) => ({ label: point.date || point.bucket, value: point.requests })),
    },
    {
      id: "errors",
      name: "오류",
      colorVar: "--obs-series-2",
      points: points.map((point) => ({ label: point.date || point.bucket, value: point.errors })),
    },
  ];
  const qualitySeries: ReadonlyArray<ChartSeries> = [
    {
      id: "eval_failures",
      name: "평가 실패",
      colorVar: "--obs-series-2",
      points: points.map((point) => ({
        label: point.date || point.bucket,
        value: point.evaluation_failures,
      })),
    },
    {
      id: "negative_feedback",
      name: "부정 피드백",
      colorVar: "--obs-series-3",
      points: points.map((point) => ({
        label: point.date || point.bucket,
        value: point.negative_feedback,
      })),
    },
  ];

  const evaluationSummary = evaluations.data?.summary ?? [];
  const totalEvaluations = evaluationSummary.reduce((sum, item) => sum + item.total, 0);
  const failedEvaluations = evaluationSummary.reduce((sum, item) => sum + item.failed, 0);
  const feedbackSummary = feedback.data?.summary;
  const alignment = feedback.data?.alignment;

  const allFailed = timeseries.isError && evaluations.isError && feedback.isError;
  if (allFailed && !timeseries.data && !evaluations.data && !feedback.data) {
    return (
      <div className="page-stack">
        <PageHeader title="LLM 관측" legacyHref="/admin#/llm" />
        <ErrorState
          message={safeAppErrorMessage(evaluations.error, "LLM 관측 데이터를 불러오지 못했습니다.")}
          requestId={isAppError(evaluations.error) ? evaluations.error.requestId : undefined}
          onRetry={refreshAll}
          onReset={resetFilters}
          legacyHref="/admin#/llm"
        />
      </div>
    );
  }

  const partialFailure =
    timeseries.isError || evaluations.isError || feedback.isError || prompts.isError || insights.isError;

  return (
    <div className="page-stack">
      <PageHeader
        title="LLM 관측"
        description="모델 호출의 품질 평가, 사용자 피드백, 프롬프트 성능을 함께 확인합니다."
        legacyHref="/admin#/llm"
        actions={
          <Button onClick={refreshAll}>
            <RefreshCw aria-hidden="true" /> 새로고침
          </Button>
        }
      />

      <form onSubmit={applyFilters}>
        <Toolbar
          label="LLM 필터"
          end={
            <>
              <Button type="submit" variant="primary">
                <Search aria-hidden="true" /> 적용
              </Button>
              <Button type="button" onClick={resetFilters}>
                초기화
              </Button>
            </>
          }
        >
          <label>
            조회 구간
            <Select
              name="window"
              value={activeWindow}
              onChange={(event) =>
                updateParams({
                  window: event.target.value === defaultWindow ? undefined : event.target.value,
                })
              }
              options={[
                { value: "24h", label: "최근 24시간" },
                { value: "7d", label: "최근 7일" },
                { value: "30d", label: "최근 30일" },
              ]}
            />
          </label>
          <label>
            API 키 ID
            <Input
              name="api_key_id"
              value={filterDraft.api_key_id}
              onChange={(event) =>
                setFilterDraft((current) => ({ ...current, api_key_id: event.target.value }))
              }
            />
          </label>
          <label>
            팀
            <Input
              name="team"
              value={filterDraft.team}
              onChange={(event) => setFilterDraft((current) => ({ ...current, team: event.target.value }))}
            />
          </label>
          <label>
            모델
            <Input
              name="model"
              value={filterDraft.model}
              onChange={(event) => setFilterDraft((current) => ({ ...current, model: event.target.value }))}
            />
          </label>
        </Toolbar>
      </form>
      {filterError ? (
        <p className="form-error" role="alert">
          {filterError}
        </p>
      ) : null}
      {scope.session_id || scope.prompt_name || scope.evaluation_name ? (
        <InlineNotice tone="info" title="세부 범위가 적용되어 있습니다.">
          <ul className="obs-tag-list">
            {scope.session_id ? (
              <li>
                <Badge tone="info">세션 {scope.session_id}</Badge>
              </li>
            ) : null}
            {scope.prompt_name ? (
              <li>
                <Badge tone="info">
                  프롬프트 {scope.prompt_name} {scope.prompt_version ?? ""}
                </Badge>
              </li>
            ) : null}
            {scope.evaluation_name ? (
              <li>
                <Badge tone="info">평가 {scope.evaluation_name}</Badge>
              </li>
            ) : null}
          </ul>
        </InlineNotice>
      ) : null}
      {partialFailure ? (
        <InlineNotice
          tone="warning"
          title="일부 영역을 갱신하지 못했습니다."
          actions={
            <Button size="small" onClick={refreshAll}>
              다시 시도
            </Button>
          }
        >
          마지막으로 확인된 데이터를 표시합니다.
        </InlineNotice>
      ) : null}

      <StatGrid label="LLM 요약">
        <StatCard label="평가" value={formatNumber(totalEvaluations)} />
        <StatCard
          label="평가 실패"
          value={formatNumber(failedEvaluations)}
          tone={failedEvaluations > 0 ? "danger" : "default"}
        />
        <StatCard label="피드백" value={formatNumber(feedbackSummary?.total ?? 0)} />
        <StatCard
          label="부정 피드백"
          value={formatNumber(feedbackSummary?.negative ?? 0)}
          tone={(feedbackSummary?.negative ?? 0) > 0 ? "warning" : "default"}
        />
        <StatCard label="정렬률" value={formatPercent(alignment?.alignment_rate ?? 0)} tone="info" />
      </StatGrid>

      <Tabs
        ariaLabel="LLM 관측 화면"
        panelIdPrefix="llm"
        items={[
          { id: "summary", label: "요약 · 추이" },
          {
            id: "evaluations",
            label: "평가",
            badge: formatNumber(evaluations.data?.evaluations.length ?? 0),
          },
          { id: "feedback", label: "피드백", badge: formatNumber(feedback.data?.feedback.length ?? 0) },
          { id: "prompts", label: "프롬프트" },
          { id: "insights", label: "인사이트" },
        ]}
        value={tab}
        onChange={setTab}
      />

      <TabPanel id={tab} panelIdPrefix="llm">
        {tab === "summary" ? (
          <div className="obs-section-stack">
            <SectionCard title="호출량 추이" description="구간별 요청 수와 오류 수입니다.">
              <TimeSeriesChart
                caption="구간별 요청 수와 오류 수"
                series={volumeSeries}
                format={(value) => formatNumber(value)}
                valueLabel="건수"
              />
            </SectionCard>
            <SectionCard title="품질 추이" description="구간별 평가 실패와 부정 피드백입니다.">
              <TimeSeriesChart
                caption="구간별 평가 실패와 부정 피드백"
                series={qualitySeries}
                format={(value) => formatNumber(value)}
                valueLabel="건수"
              />
            </SectionCard>
            <SectionCard title="상위 인사이트" description="규칙 기반으로 탐지한 최근 신호입니다.">
              {(insights.data?.insights ?? []).length === 0 ? (
                <EmptyState
                  title="탐지된 인사이트가 없습니다."
                  description="호출이 쌓이면 오류·비용·품질 신호가 자동으로 정리됩니다."
                />
              ) : (
                <ul className="obs-timeline">
                  {(insights.data?.insights ?? []).slice(0, 5).map((item, index) => (
                    <li key={`${item.id}-${index}`} className="obs-timeline-item">
                      <div className="obs-timeline-when">
                        <Badge tone={severityTone(item.severity)}>{item.severity || "info"}</Badge>
                      </div>
                      <div className="obs-timeline-body">
                        <strong>{item.title}</strong>
                        <div>{item.detail}</div>
                        <div className="obs-meta">
                          <span>{item.recommendation}</span>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>
          </div>
        ) : null}

        {tab === "evaluations" ? (
          <div className="obs-section-stack">
            <SectionCard title="평가 요약" description="평가 이름별 통과·실패 집계입니다.">
              {evaluationSummary.length === 0 ? (
                <EmptyState
                  title="집계된 평가가 없습니다."
                  description="평가기를 연결하면 이름별 통과율이 표시됩니다."
                />
              ) : (
                <div className="data-table-scroll" tabIndex={0} aria-label="평가 요약 표 영역">
                  <table className="data-table">
                    <caption className="sr-only">평가 이름별 집계</caption>
                    <thead>
                      <tr>
                        <th scope="col">평가</th>
                        <th scope="col">분류</th>
                        <th scope="col">전체</th>
                        <th scope="col">통과</th>
                        <th scope="col">실패</th>
                        <th scope="col">평균 점수</th>
                      </tr>
                    </thead>
                    <tbody>
                      {evaluationSummary.map((item, index) => (
                        <tr key={`${item.name}-${index}`}>
                          <th scope="row">
                            <Button
                              size="small"
                              variant="ghost"
                              onClick={() => updateParams({ evaluation_name: item.name })}
                            >
                              {item.name || "—"}
                            </Button>
                          </th>
                          <td>{item.category || "—"}</td>
                          <td className="cell-number">{formatNumber(item.total)}</td>
                          <td className="cell-number">{formatNumber(item.passed)}</td>
                          <td className="cell-number">{formatNumber(item.failed)}</td>
                          <td className="cell-number">{item.average_score.toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </SectionCard>

            <SectionCard title="최근 평가" description="행을 선택하면 해당 호출의 상세가 열립니다.">
              {(evaluations.data?.evaluations ?? []).length === 0 ? (
                <EmptyState
                  title="최근 평가가 없습니다."
                  description="평가 결과가 등록되면 여기에서 실패한 호출을 바로 열 수 있습니다."
                />
              ) : (
                <div className="data-table-scroll" tabIndex={0} aria-label="최근 평가 표 영역">
                  <table className="data-table">
                    <caption className="sr-only">최근 평가 결과</caption>
                    <thead>
                      <tr>
                        <th scope="col">시각</th>
                        <th scope="col">평가</th>
                        <th scope="col">결과</th>
                        <th scope="col">점수</th>
                        <th scope="col">사유</th>
                        <th scope="col">작업</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(evaluations.data?.evaluations ?? []).map((item, index) => (
                        <tr key={`${item.id}-${index}`}>
                          <th scope="row">{formatDateTime(item.created_at)}</th>
                          <td>{item.name || "—"}</td>
                          <td>
                            <Badge tone={item.passed ? "success" : "danger"}>
                              {item.label || (item.passed ? "pass" : "fail")}
                            </Badge>
                          </td>
                          <td className="cell-number">{item.score.toFixed(2)}</td>
                          <td className="truncate">{item.reason || "—"}</td>
                          <td>
                            <Button
                              size="small"
                              onClick={(event) => {
                                detailFocusRef.current = event.currentTarget;
                                setSelectedRequestId(item.request_id);
                              }}
                              aria-label={`${item.request_id} 호출 상세 열기`}
                            >
                              상세
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </SectionCard>
          </div>
        ) : null}

        {tab === "feedback" ? (
          <div className="obs-section-stack">
            <SectionCard
              title="피드백 요약"
              description="사람이 남긴 평가와 자동 평가의 정렬 상태입니다."
              actions={
                <Button
                  variant="primary"
                  size="small"
                  disabled={!canWrite}
                  title={canWrite ? undefined : writeDeniedReason}
                  onClick={(event) => openFeedback("", "", event.currentTarget)}
                >
                  <MessageSquarePlus aria-hidden="true" /> 피드백 남기기
                </Button>
              }
            >
              {!canWrite ? (
                <InlineNotice tone="warning" title="쓰기 권한이 없습니다.">
                  {writeDeniedReason}
                </InlineNotice>
              ) : null}
              <StatGrid label="피드백 집계">
                <StatCard label="전체" value={formatNumber(feedbackSummary?.total ?? 0)} />
                <StatCard label="긍정" value={formatNumber(feedbackSummary?.positive ?? 0)} tone="success" />
                <StatCard label="부정" value={formatNumber(feedbackSummary?.negative ?? 0)} tone="danger" />
                <StatCard label="평균 평점" value={(feedbackSummary?.average_rating ?? 0).toFixed(2)} />
                <StatCard label="정렬" value={formatNumber(alignment?.aligned ?? 0)} tone="info" />
                <StatCard
                  label="불일치"
                  value={formatNumber(alignment?.misaligned ?? 0)}
                  tone={(alignment?.misaligned ?? 0) > 0 ? "warning" : "default"}
                />
              </StatGrid>
            </SectionCard>

            <SectionCard title="최근 피드백">
              {(feedback.data?.feedback ?? []).length === 0 ? (
                <EmptyState
                  title="등록된 피드백이 없습니다."
                  description="호출 상세에서 피드백을 남기면 프롬프트 개선 근거로 쌓입니다."
                />
              ) : (
                <div className="data-table-scroll" tabIndex={0} aria-label="최근 피드백 표 영역">
                  <table className="data-table">
                    <caption className="sr-only">최근 사용자 피드백</caption>
                    <thead>
                      <tr>
                        <th scope="col">시각</th>
                        <th scope="col">평점</th>
                        <th scope="col">라벨</th>
                        <th scope="col">의견</th>
                        <th scope="col">작성자</th>
                        <th scope="col">작업</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(feedback.data?.feedback ?? []).map((item, index) => (
                        <tr key={`${item.id}-${index}`}>
                          <th scope="row">{formatDateTime(item.created_at)}</th>
                          <td>
                            <Badge tone={item.rating > 0 ? "success" : item.rating < 0 ? "danger" : "muted"}>
                              {formatNumber(item.rating)}
                            </Badge>
                          </td>
                          <td>{item.label || "—"}</td>
                          <td className="truncate">{item.comment || "—"}</td>
                          <td>{item.created_by || "—"}</td>
                          <td>
                            <Button
                              size="small"
                              onClick={(event) => {
                                detailFocusRef.current = event.currentTarget;
                                setSelectedRequestId(item.request_id);
                              }}
                              aria-label={`${item.request_id} 호출 상세 열기`}
                            >
                              상세
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </SectionCard>

            <SectionCard
              title="프롬프트별 정렬"
              description="자동 평가와 사람 평가가 어긋나는 프롬프트입니다."
            >
              {(feedback.data?.alignment_prompts ?? []).length === 0 ? (
                <EmptyState
                  title="비교할 프롬프트가 없습니다."
                  description="프롬프트 이름을 함께 기록하면 버전별 정렬률이 표시됩니다."
                />
              ) : (
                <div className="data-table-scroll" tabIndex={0} aria-label="프롬프트별 정렬 표 영역">
                  <table className="data-table">
                    <caption className="sr-only">프롬프트별 평가·피드백 정렬</caption>
                    <thead>
                      <tr>
                        <th scope="col">프롬프트</th>
                        <th scope="col">버전</th>
                        <th scope="col">표본</th>
                        <th scope="col">정렬률</th>
                        <th scope="col">부정 피드백</th>
                        <th scope="col">평가 실패율</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(feedback.data?.alignment_prompts ?? []).map((item, index) => (
                        <tr key={`${item.prompt_name}-${item.prompt_version}-${index}`}>
                          <th scope="row">{item.prompt_name || "—"}</th>
                          <td>{item.prompt_version || "—"}</td>
                          <td className="cell-number">{formatNumber(item.total)}</td>
                          <td className="cell-number">{formatPercent(item.alignment_rate)}</td>
                          <td className="cell-number">{formatNumber(item.human_negative)}</td>
                          <td className="cell-number">{formatPercent(item.eval_failure_rate)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </SectionCard>
          </div>
        ) : null}

        {tab === "prompts" ? (
          <SectionCard title="프롬프트 추적" description="프롬프트 이름과 버전별 호출량, 비용, 실패율입니다.">
            {(prompts.data?.prompts ?? []).length === 0 ? (
              <EmptyState
                title="프롬프트 통계가 없습니다."
                description="요청에 prompt_name과 prompt_version을 실어 보내면 버전별 성능을 비교할 수 있습니다."
              />
            ) : (
              <div className="data-table-scroll" tabIndex={0} aria-label="프롬프트 표 영역">
                <table className="data-table">
                  <caption className="sr-only">프롬프트별 호출 통계</caption>
                  <thead>
                    <tr>
                      <th scope="col">프롬프트</th>
                      <th scope="col">버전</th>
                      <th scope="col">호출</th>
                      <th scope="col">토큰</th>
                      <th scope="col">비용</th>
                      <th scope="col">평균 지연</th>
                      <th scope="col">오류</th>
                      <th scope="col">평가 실패</th>
                      <th scope="col">작업</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(prompts.data?.prompts ?? []).map((item, index) => (
                      <tr key={`${item.prompt_name}-${item.prompt_version}-${index}`}>
                        <th scope="row">{item.prompt_name || "—"}</th>
                        <td>{item.prompt_version || "—"}</td>
                        <td className="cell-number">{formatNumber(item.calls)}</td>
                        <td className="cell-number">{formatNumber(item.tokens)}</td>
                        <td className="cell-number">{formatKRW(item.cost_krw)}</td>
                        <td className="cell-number">{formatNumber(item.average_latency_ms)}ms</td>
                        <td className="cell-number">{formatNumber(item.errors)}</td>
                        <td className="cell-number">{formatNumber(item.eval_failures)}</td>
                        <td>
                          <Button
                            size="small"
                            onClick={(event) => {
                              compareFocusRef.current = event.currentTarget;
                              setComparePrompt({
                                name: item.prompt_name,
                                version: item.prompt_version,
                              });
                            }}
                            aria-label={`${item.prompt_name} 버전 비교`}
                          >
                            버전 비교
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>
        ) : null}

        {tab === "insights" ? (
          <div className="obs-section-stack">
            <SectionCard title="인사이트" description="규칙 기반으로 탐지한 운영 신호입니다.">
              {(insights.data?.insights ?? []).length === 0 ? (
                <EmptyState
                  title="탐지된 인사이트가 없습니다."
                  description="호출이 쌓이면 오류·비용·품질 신호가 자동으로 정리됩니다."
                />
              ) : (
                <div className="data-table-scroll" tabIndex={0} aria-label="인사이트 표 영역">
                  <table className="data-table">
                    <caption className="sr-only">LLM 인사이트</caption>
                    <thead>
                      <tr>
                        <th scope="col">심각도</th>
                        <th scope="col">제목</th>
                        <th scope="col">범위</th>
                        <th scope="col">건수</th>
                        <th scope="col">권고</th>
                        <th scope="col">마지막</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(insights.data?.insights ?? []).map((item, index) => (
                        <tr key={`${item.id}-${index}`}>
                          <th scope="row">
                            <Badge tone={severityTone(item.severity)}>{item.severity || "info"}</Badge>
                          </th>
                          <td>{item.title || "—"}</td>
                          <td>
                            {item.scope}: {item.scope_value}
                          </td>
                          <td className="cell-number">{formatNumber(item.count)}</td>
                          <td className="truncate">{item.recommendation || "—"}</td>
                          <td>{formatDateTime(item.last_seen)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </SectionCard>

            <SectionCard title="반복 패턴" description="비슷한 요청이 반복되는 패턴입니다.">
              {(patterns.data?.patterns ?? []).length === 0 ? (
                <EmptyState
                  title="패턴이 없습니다."
                  description="같은 형태의 요청이 반복되면 캐싱·프롬프트 개선 후보로 표시됩니다."
                />
              ) : (
                <div className="data-table-scroll" tabIndex={0} aria-label="반복 패턴 표 영역">
                  <table className="data-table">
                    <caption className="sr-only">반복되는 요청 패턴</caption>
                    <thead>
                      <tr>
                        <th scope="col">패턴</th>
                        <th scope="col">언어</th>
                        <th scope="col">요청</th>
                        <th scope="col">토큰</th>
                        <th scope="col">비용</th>
                        <th scope="col">오류</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(patterns.data?.patterns ?? []).map((item, index) => (
                        <tr key={`${item.pattern}-${index}`}>
                          <th scope="row" className="truncate">
                            {item.pattern || "—"}
                          </th>
                          <td>{item.language || "—"}</td>
                          <td className="cell-number">{formatNumber(item.requests)}</td>
                          <td className="cell-number">{formatNumber(item.tokens)}</td>
                          <td className="cell-number">{formatKRW(item.cost_krw)}</td>
                          <td className="cell-number">{formatNumber(item.errors)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </SectionCard>
          </div>
        ) : null}
      </TabPanel>

      <Sheet
        open={selectedRequestId !== ""}
        onOpenChange={(next) => {
          if (!next) setSelectedRequestId("");
        }}
        returnFocusRef={detailFocusRef}
        size="wide"
        title="LLM 호출 상세"
        description="평가, 피드백, 도구 호출과 코드 검증 결과를 확인합니다. 프롬프트 원문은 표시하지 않습니다."
      >
        {selectedRequestId ? (
          <LLMTraceDetail
            requestId={selectedRequestId}
            canWriteFeedback={canWrite}
            writeDeniedReason={writeDeniedReason}
            onWriteFeedback={(requestId, traceId) => openFeedback(requestId, traceId)}
          />
        ) : null}
      </Sheet>

      <FormDialog
        open={feedbackTarget !== undefined}
        onOpenChange={(next) => {
          if (!next) setFeedbackTarget(undefined);
        }}
        returnFocusRef={feedbackFocusRef}
        form={feedbackForm}
        title="피드백 남기기"
        description="이 호출의 품질을 평가합니다. 프롬프트 원문은 입력하지 마세요."
        submitLabel="등록"
        onSubmit={async (values) => {
          await submitFeedback.mutateAsync(values);
        }}
      >
        <FormField label="요청 ID" required error={feedbackForm.formState.errors.request_id?.message}>
          {(control) => <Input {...control} {...feedbackForm.register("request_id")} />}
        </FormField>
        <FormField label="평점" required error={feedbackForm.formState.errors.rating?.message}>
          {(control) => (
            <Select
              {...control}
              {...feedbackForm.register("rating")}
              options={[
                { value: "1", label: "긍정 (+1)" },
                { value: "0", label: "보통 (0)" },
                { value: "-1", label: "부정 (-1)" },
              ]}
            />
          )}
        </FormField>
        <FormField label="라벨" error={feedbackForm.formState.errors.label?.message}>
          {(control) => (
            <Input {...control} {...feedbackForm.register("label")} placeholder="예: hallucination" />
          )}
        </FormField>
        <FormField label="의견" error={feedbackForm.formState.errors.comment?.message}>
          {(control) => <Textarea {...control} rows={3} {...feedbackForm.register("comment")} />}
        </FormField>
      </FormDialog>

      <PromptCompareDialog
        prompt={comparePrompt}
        scope={scope}
        returnFocusRef={compareFocusRef}
        onOpenChange={(next) => {
          if (!next) setComparePrompt(undefined);
        }}
      />
    </div>
  );
}
