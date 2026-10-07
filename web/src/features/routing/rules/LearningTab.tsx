import { useQuery } from "@tanstack/react-query";

import { routingDomainQueryKey, writeScopeMessage } from "@/features/routing/rules/routing-shared";
import { ScopeNotice } from "@/features/routing/rules/routing-ui";
import { apiClient } from "@/shared/api/client";
import type { DomainReviewStatus } from "@/shared/api/domains/routing-domain-review";
import { endpoints } from "@/shared/api/endpoints";
import { isAppError } from "@/shared/api/error";
import { Badge } from "@/shared/components/ui/Badge";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { Toolbar } from "@/shared/components/ui/Toolbar";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { formatDateTime, formatNumber, formatPercent, shortId } from "@/shared/utils/format";
import { LearningRecommendationSection } from "./LearningRecommendationSection";
import { DomainReviewSection } from "./DomainReviewSection";
import { domainReviewStatuses, domainReviewStatusLabels } from "./domain-review-state";
import { learningWindows, learningWindowLabels, type LearningWindow } from "./learning-recommendation-state";

const defaultWindow = "7d";
const defaultStatus = "pending";

function windowFrom(value: string | null): LearningWindow {
  return (learningWindows as readonly string[]).includes(value ?? "")
    ? (value as LearningWindow)
    : defaultWindow;
}

function statusFrom(value: string | null): DomainReviewStatus {
  return (domainReviewStatuses as readonly string[]).includes(value ?? "")
    ? (value as DomainReviewStatus)
    : defaultStatus;
}

function permissionMessage(error: unknown): string | undefined {
  return isAppError(error) && (error.kind === "permission" || error.status === 403)
    ? "도메인 라우팅 학습 데이터는 프롬프트 원문 조회 권한이 있는 계정만 볼 수 있습니다."
    : undefined;
}

export function LearningTab({ canWrite }: { canWrite: boolean }): React.JSX.Element {
  const [searchParams, updateSearch] = useSearchState();
  const window = windowFrom(searchParams.get("window"));
  const status = statusFrom(searchParams.get("status"));
  const route = searchParams.get("route") ?? "";

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

  const decisions = domainDecisions.data?.decisions ?? [];
  const averageConfidence =
    decisions.length > 0 ? decisions.reduce((sum, item) => sum + item.confidence, 0) / decisions.length : 0;
  const averageEvidence =
    decisions.length > 0
      ? decisions.reduce((sum, item) => sum + item.evidence_score, 0) / decisions.length
      : 0;
  const domainPermission = permissionMessage(domainDecisions.error);

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
            {learningWindows.map((item) => (
              <option key={item} value={item}>
                {learningWindowLabels[item]}
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
            {domainReviewStatuses.map((item) => (
              <option key={item} value={item}>
                {domainReviewStatusLabels[item]}
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

      <DomainReviewSection canWrite={canWrite} status={status}>
        {(pendingReviews) => (
          <LearningRecommendationSection
            canWrite={canWrite}
            window={window}
            pendingReviews={pendingReviews}
          />
        )}
      </DomainReviewSection>

      {domainPermission ? (
        <InlineNotice tone="info" title="도메인 학습 데이터를 볼 수 없습니다.">
          {domainPermission}
        </InlineNotice>
      ) : null}

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

      <SectionCard
        title="도메인 학습 예시"
        description="서버에 저장된 학습 예시입니다. 검토 상태 기록과는 별도입니다."
      >
        {domainPermission || examples.isError ? (
          <EmptyState
            title="표시할 수 없습니다."
            description={domainPermission ?? "학습 예시를 불러오지 못했습니다."}
          />
        ) : (examples.data?.examples.length ?? 0) === 0 ? (
          <EmptyState
            title="저장된 예시가 없습니다."
            description="검토 상태 승인만으로 학습 예시가 만들어지지는 않습니다."
          />
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
    </div>
  );
}
