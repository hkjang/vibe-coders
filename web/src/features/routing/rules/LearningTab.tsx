import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import {
  routingDomainQueryKey,
  routingLearningQueryKey,
  routingRulesQueryKey,
  writeScopeMessage,
} from "@/features/routing/rules/routing-shared";
import { QueryFailureNotice, ScopeNotice } from "@/features/routing/rules/routing-ui";
import { apiClient } from "@/shared/api/client";
import {
  domainReviewActionEndpoint,
  type RoutingDomainReviewItem,
  type RoutingLearningReport,
  type RoutingRuleInput,
} from "@/shared/api/domains/routing";
import { endpoints } from "@/shared/api/endpoints";
import { isAppError } from "@/shared/api/error";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { Toolbar } from "@/shared/components/ui/Toolbar";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import { DataTable } from "@/shared/data-table/DataTable";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { formatDateTime, formatKRW, formatNumber, formatPercent, shortId } from "@/shared/utils/format";

const windows = ["24h", "7d", "30d", "90d"] as const;
const defaultWindow = "7d";
const reviewStatuses = ["pending", "approved", "rejected"] as const;
const defaultStatus = "pending";

type Recommendation = RoutingLearningReport["recommendations"][number];

const bucketRanges: Record<string, { min: number; max: number }> = {
  low: { min: 0, max: 34 },
  medium: { min: 35, max: 69 },
  high: { min: 70, max: 100 },
};

function windowFrom(value: string | null): string {
  return (windows as readonly string[]).includes(value ?? "") ? (value as string) : defaultWindow;
}

function statusFrom(value: string | null): string {
  return (reviewStatuses as readonly string[]).includes(value ?? "") ? (value as string) : defaultStatus;
}

function permissionMessage(error: unknown): string | undefined {
  return isAppError(error) && (error.kind === "permission" || error.status === 403)
    ? "도메인 라우팅 학습 데이터는 프롬프트 원문 조회 권한이 있는 계정만 볼 수 있습니다."
    : undefined;
}

function recommendationColumns(
  canWrite: boolean,
  onApply: (recommendation: Recommendation, trigger: HTMLButtonElement) => void,
): ReadonlyArray<DataTableColumn<Recommendation>> {
  const column = createDataTableColumnHelper<Recommendation>();
  return column.columns([
    column.accessor((row) => row.task_type, { id: "task_type", header: "작업 유형" }),
    column.accessor((row) => row.bucket, {
      id: "bucket",
      header: "복잡도 구간",
      cell: ({ getValue }) => <Badge tone="info">{getValue()}</Badge>,
    }),
    column.accessor((row) => row.top_model, {
      id: "top_model",
      header: "현재 주력 모델",
      cell: ({ row, getValue }) => (
        <span className="mono">
          {getValue() || "—"} ({formatPercent(row.original.top_success_rate)})
        </span>
      ),
    }),
    column.accessor((row) => row.recommended_model, {
      id: "recommended_model",
      header: "추천 모델",
      cell: ({ row, getValue }) => (
        <span className="mono">
          {getValue() || "—"} ({formatPercent(row.original.success_rate)})
        </span>
      ),
    }),
    column.accessor((row) => row.avg_cost_krw, {
      id: "cost",
      header: "평균 비용",
      cell: ({ getValue }) => <span className="cell-number">{formatKRW(getValue())}</span>,
    }),
    column.accessor((row) => row.samples, {
      id: "samples",
      header: "표본",
      cell: ({ row, getValue }) => (
        <span className="cell-number">
          {formatNumber(getValue())}
          {row.original.confident ? "" : " (부족)"}
        </span>
      ),
    }),
    column.display({
      id: "actions",
      header: "작업",
      cell: ({ row }) =>
        row.original.differs ? (
          <Button
            size="small"
            variant="ghost"
            aria-label={`${row.original.recommended_model} 추천을 규칙으로 적용`}
            disabled={!canWrite}
            title={canWrite ? undefined : writeScopeMessage}
            onClick={(event) => onApply(row.original, event.currentTarget)}
          >
            규칙 적용
          </Button>
        ) : (
          <span className="routing-meta">이미 사용 중</span>
        ),
    }),
  ]);
}

function reviewColumns(
  canWrite: boolean,
  onDecide: (item: RoutingDomainReviewItem, action: "approve" | "reject", trigger: HTMLButtonElement) => void,
): ReadonlyArray<DataTableColumn<RoutingDomainReviewItem>> {
  const column = createDataTableColumnHelper<RoutingDomainReviewItem>();
  return column.columns([
    column.accessor((row) => row.created_at, {
      id: "created_at",
      header: "등록",
      cell: ({ getValue }) => formatDateTime(getValue()),
    }),
    column.accessor((row) => row.current_route, { id: "current_route", header: "현재 라우트" }),
    column.accessor((row) => row.suggested_route, {
      id: "suggested_route",
      header: "제안 라우트",
      cell: ({ getValue }) => <strong>{getValue() || "—"}</strong>,
    }),
    column.accessor((row) => row.reason, {
      id: "reason",
      header: "사유",
      cell: ({ getValue }) => (
        <span className="truncate" title={getValue()}>
          {getValue() || "—"}
        </span>
      ),
    }),
    column.accessor((row) => row.status, {
      id: "status",
      header: "상태",
      cell: ({ getValue }) => (
        <Badge tone={getValue() === "pending" ? "warning" : "muted"}>{getValue()}</Badge>
      ),
    }),
    column.display({
      id: "actions",
      header: "작업",
      cell: ({ row }) => (
        <span className="routing-tab-actions">
          <Button
            size="small"
            aria-label={`${shortId(row.original.id)} 검토 승인`}
            disabled={!canWrite || row.original.status !== "pending"}
            title={canWrite ? undefined : writeScopeMessage}
            onClick={(event) => onDecide(row.original, "approve", event.currentTarget)}
          >
            승인
          </Button>
          <Button
            size="small"
            variant="ghost"
            aria-label={`${shortId(row.original.id)} 검토 거절`}
            disabled={!canWrite || row.original.status !== "pending"}
            title={canWrite ? undefined : writeScopeMessage}
            onClick={(event) => onDecide(row.original, "reject", event.currentTarget)}
          >
            거절
          </Button>
        </span>
      ),
    }),
  ]);
}

export function LearningTab({ canWrite }: { canWrite: boolean }): React.JSX.Element {
  const [searchParams, updateSearch] = useSearchState();
  const window = windowFrom(searchParams.get("window"));
  const status = statusFrom(searchParams.get("status"));
  const route = searchParams.get("route") ?? "";
  const [pendingApply, setPendingApply] = useState<Recommendation>();
  const [pendingReview, setPendingReview] = useState<{
    item: RoutingDomainReviewItem;
    action: "approve" | "reject";
  }>();
  const [applyTrigger, setApplyTrigger] = useState<HTMLElement | null>(null);
  const [reviewTrigger, setReviewTrigger] = useState<HTMLElement | null>(null);

  const learning = useQuery({
    queryKey: [...routingLearningQueryKey, window],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.routing.learning, {
        query: { window },
        signal,
        routeId: "routing.rules",
      }),
  });
  const domainDecisions = useQuery({
    queryKey: [...routingDomainQueryKey, "decisions", window, route],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.routing.domain.decisions, {
        query: { window, ...(route === "" ? {} : { route }) },
        signal,
        routeId: "routing.rules",
      }),
    retry: false,
  });
  const reviewQueue = useQuery({
    queryKey: [...routingDomainQueryKey, "review", status, route],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.routing.domain.review, {
        query: { status, ...(route === "" ? {} : { route }) },
        signal,
        routeId: "routing.rules",
      }),
    retry: false,
  });
  const examples = useQuery({
    queryKey: [...routingDomainQueryKey, "examples", route],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.routing.domain.examples, {
        query: route === "" ? undefined : { route },
        signal,
        routeId: "routing.rules",
      }),
    retry: false,
  });

  const applyRecommendation = useMutationFeedback<RoutingRuleInput, unknown>({
    mutate: (body) => apiClient.request(endpoints.domains.routing.rules.create, { body }),
    invalidates: [routingRulesQueryKey],
    successMessage: "추천을 라우팅 규칙으로 만들었습니다.",
    errorMessage: "추천을 규칙으로 만들지 못했습니다.",
  });
  const decideReview = useMutationFeedback<{ id: string; action: "approve" | "reject" }, unknown>({
    mutate: ({ id, action }) => apiClient.request(domainReviewActionEndpoint(id, action)),
    invalidates: [routingDomainQueryKey],
    successMessage: "검토 결과를 저장했습니다.",
    errorMessage: "검토 결과를 저장하지 못했습니다.",
  });

  const recommendations = learning.data?.recommendations ?? [];
  const decisions = domainDecisions.data?.decisions ?? [];
  const reviewItems = reviewQueue.data?.items ?? [];
  const averageConfidence =
    decisions.length > 0 ? decisions.reduce((sum, item) => sum + item.confidence, 0) / decisions.length : 0;
  const averageEvidence =
    decisions.length > 0
      ? decisions.reduce((sum, item) => sum + item.evidence_score, 0) / decisions.length
      : 0;
  const domainPermission = permissionMessage(domainDecisions.error) ?? permissionMessage(reviewQueue.error);

  return (
    <div className="routing-panel-stack">
      {canWrite ? null : <ScopeNotice>{writeScopeMessage}</ScopeNotice>}

      <Toolbar label="학습 조회 조건">
        <label className="form-field">
          <span>학습 구간</span>
          <select
            className="input select"
            value={window}
            onChange={(event) => updateSearch({ window: event.target.value })}
          >
            {windows.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
        <label className="form-field">
          <span>검토 상태</span>
          <select
            className="input select"
            value={status}
            onChange={(event) => updateSearch({ status: event.target.value })}
          >
            {reviewStatuses.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
        <label className="form-field">
          <span>라우트</span>
          <input
            className="input"
            value={route}
            placeholder="전체"
            onChange={(event) => updateSearch({ route: event.target.value || undefined })}
          />
        </label>
      </Toolbar>

      {learning.isError ? (
        <QueryFailureNotice
          error={learning.error}
          hasData={Boolean(learning.data)}
          label="라우팅 학습 리포트"
          onRetry={() => void learning.refetch()}
        />
      ) : null}

      <StatGrid label="학습 요약">
        <StatCard label="학습 셀" value={formatNumber(learning.data?.cells.length)} />
        <StatCard label="추천" value={formatNumber(recommendations.length)} />
        <StatCard label="최소 표본" value={formatNumber(learning.data?.min_samples)} />
        <StatCard
          label="검토 대기"
          tone={reviewItems.length > 0 ? "warning" : "default"}
          value={domainPermission ? "—" : formatNumber(reviewItems.length)}
        />
      </StatGrid>

      <SectionCard
        title="모델 추천 학습"
        description="성공률과 비용 기록에서 (작업 유형 × 복잡도 구간)별로 더 나은 모델을 찾아 제안합니다."
      >
        <DataTable
          caption="학습된 모델 추천"
          columns={recommendationColumns(canWrite, (recommendation, trigger) => {
            setApplyTrigger(trigger);
            setPendingApply(recommendation);
          })}
          data={recommendations}
          emptyMessage="표본이 충분한 추천이 아직 없습니다. 요청이 쌓이면 추천이 나타납니다."
          error={learning.isError && !learning.data ? "학습 리포트를 불러오지 못했습니다." : undefined}
          getRowId={(row, index) => `${row.task_type}-${row.bucket}-${index}`}
          loading={learning.isPending}
          onRetry={() => void learning.refetch()}
        />
      </SectionCard>

      {domainPermission ? (
        <InlineNotice tone="info" title="도메인 학습 데이터를 볼 수 없습니다.">
          {domainPermission}
        </InlineNotice>
      ) : null}

      {!domainPermission && reviewQueue.isError ? (
        <QueryFailureNotice
          error={reviewQueue.error}
          hasData={Boolean(reviewQueue.data)}
          label="도메인 라우팅 검토 큐"
          onRetry={() => void reviewQueue.refetch()}
        />
      ) : null}

      <SectionCard
        title="도메인 라우팅 검토 큐"
        description="자동 분류가 확신하지 못한 요청입니다. 승인하면 학습 예시로 승격됩니다."
      >
        {domainPermission ? (
          <EmptyState title="표시할 수 없습니다." description={domainPermission} />
        ) : (
          <DataTable
            caption="도메인 라우팅 검토 큐"
            columns={reviewColumns(canWrite, (item, action, trigger) => {
              setReviewTrigger(trigger);
              setPendingReview({ item, action });
            })}
            data={reviewItems}
            emptyMessage="검토할 항목이 없습니다."
            getRowId={(row, index) => row.id || String(index)}
            loading={reviewQueue.isPending}
            onRetry={() => void reviewQueue.refetch()}
          />
        )}
      </SectionCard>

      <SectionCard
        title="도메인 결정 로그"
        description="도메인 라우터가 어떤 근거로 라우트를 골랐는지 기록입니다."
      >
        {domainPermission ? (
          <EmptyState title="표시할 수 없습니다." description={domainPermission} />
        ) : decisions.length === 0 ? (
          <EmptyState
            title="결정 로그가 없습니다."
            description="도메인 라우팅이 동작하면 신뢰도와 증거 점수가 쌓입니다."
          />
        ) : (
          <>
            <StatGrid label="도메인 결정 요약">
              <StatCard label="결정 로그" value={formatNumber(decisions.length)} />
              <StatCard label="평균 신뢰도" value={formatPercent(averageConfidence)} />
              <StatCard label="평균 증거 점수" value={formatNumber(averageEvidence, 2)} />
              <StatCard
                label="폴백 사용"
                value={formatNumber(decisions.filter((item) => item.fallback_used).length)}
              />
            </StatGrid>
            <ul className="routing-steps">
              {decisions.slice(0, 20).map((decision) => (
                <li key={decision.id}>
                  <Badge tone={decision.blocked_by_governance ? "danger" : "info"}>
                    {decision.route || "—"}
                  </Badge>
                  <strong className="mono">{shortId(decision.request_id)}</strong>
                  <span className="routing-meta">
                    신뢰도 {formatPercent(decision.confidence)} · 증거{" "}
                    {formatNumber(decision.evidence_score, 2)}({formatNumber(decision.evidence_count)}건) ·{" "}
                    {formatDateTime(decision.created_at)}
                    {decision.reason ? ` · ${decision.reason}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </SectionCard>

      <SectionCard title="자동 승격 예시" description="검토를 통과해 학습 예시로 승격된 항목입니다.">
        {domainPermission || examples.isError ? (
          <EmptyState
            title="표시할 수 없습니다."
            description={domainPermission ?? "학습 예시를 불러오지 못했습니다."}
          />
        ) : (examples.data?.examples.length ?? 0) === 0 ? (
          <EmptyState title="승격된 예시가 없습니다." description="검토 큐에서 승인하면 예시가 쌓입니다." />
        ) : (
          <ul className="routing-steps">
            {(examples.data?.examples ?? []).slice(0, 20).map((example) => (
              <li key={example.id}>
                <Badge tone={example.auto_promoted ? "success" : "muted"}>{example.route}</Badge>
                <span className="routing-meta">
                  출처 {example.source} · 신뢰도 {formatPercent(example.confidence)} ·{" "}
                  {formatDateTime(example.created_at)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <ConfirmDialog
        confirmLabel="규칙 만들기"
        description={
          pendingApply
            ? `${pendingApply.task_type} / ${pendingApply.bucket} 요청을 ${pendingApply.recommended_model} 로 라우팅하는 규칙을 만듭니다.`
            : "추천을 규칙으로 만듭니다."
        }
        onConfirm={async () => {
          if (!pendingApply) return;
          const range = bucketRanges[pendingApply.bucket] ?? { min: 0, max: 100 };
          await applyRecommendation.mutateAsync({
            match_pattern: "*",
            target_model: pendingApply.recommended_model,
            target_provider: "",
            min_complexity: range.min,
            max_complexity: range.max,
            priority: 100,
            enabled: true,
            note: `학습 추천 적용 (${pendingApply.task_type}/${pendingApply.bucket})`,
          });
        }}
        onOpenChange={(open) => {
          if (!open) setPendingApply(undefined);
        }}
        open={pendingApply !== undefined}
        returnFocusRef={{ current: applyTrigger }}
        title="추천을 규칙으로 적용"
      >
        <p>
          만들어진 규칙은 모든 모델 패턴(*)에 적용됩니다. 필요하면 규칙 탭에서 패턴과 우선순위를 조정하세요.
        </p>
      </ConfirmDialog>

      <ConfirmDialog
        confirmLabel={pendingReview?.action === "reject" ? "거절" : "승인"}
        description={
          pendingReview
            ? `제안 라우트 ${pendingReview.item.suggested_route || "—"} 를 ${
                pendingReview.action === "reject" ? "거절" : "승인"
              }합니다.`
            : "검토 항목을 처리합니다."
        }
        onConfirm={async () => {
          if (pendingReview) {
            await decideReview.mutateAsync({ id: pendingReview.item.id, action: pendingReview.action });
          }
        }}
        onOpenChange={(open) => {
          if (!open) setPendingReview(undefined);
        }}
        open={pendingReview !== undefined}
        returnFocusRef={{ current: reviewTrigger }}
        title="도메인 라우팅 검토"
        tone={pendingReview?.action === "reject" ? "danger" : "primary"}
      >
        <p>승인하면 이 제안이 학습 예시로 승격되어 이후 라우팅에 반영됩니다.</p>
      </ConfirmDialog>
    </div>
  );
}
