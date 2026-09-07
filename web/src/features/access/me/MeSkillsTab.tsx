import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { formatSignedRatio, severityTone } from "@/features/access/access-format";
import { QueryNotice } from "@/features/access/access-ui";
import { meKeys, useMeSkillsQuery } from "@/features/access/me/use-me-queries";
import { apiClient } from "@/shared/api/client";
import { withPathParams, type RecommendationFeedbackBody } from "@/shared/api/domains/access";
import { endpoints } from "@/shared/api/endpoints";
import { LoadingState } from "@/shared/components/state/PageStates";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { formatKRW, formatNumber } from "@/shared/utils/format";

const access = endpoints.domains.access;
const routeId = "me.home";

export function MeSkillsTab(): React.JSX.Element {
  const skills = useMeSkillsQuery(true);
  const [recommendationsRequested, setRecommendationsRequested] = useState(false);
  // Every GET regenerates and replaces the caller's recommendations, so this is
  // deliberately opt-in rather than loaded with the tab.
  const recommendations = useQuery({
    queryKey: meKeys.recommendations,
    enabled: recommendationsRequested,
    queryFn: ({ signal }) => apiClient.request(access.me.recommendations, { signal, routeId }),
  });

  const feedback = useMutationFeedback({
    mutate: ({ id, body }: { id: string; body: RecommendationFeedbackBody }) =>
      apiClient.request(withPathParams(access.me.recommendationFeedback, { id }), { body, routeId }),
    invalidates: [meKeys.recommendations],
    successMessage: "의견을 반영했습니다.",
  });

  if (skills.isPending && !skills.data) return <LoadingState label="Skill 목록을 불러오는 중입니다." />;

  const available = skills.data?.available ?? [];
  const requestable = skills.data?.requestable ?? [];
  const recommendationRows = recommendations.data?.recommendations ?? [];

  return (
    <div className="access-stack">
      {skills.isError ? (
        <QueryNotice
          error={skills.error}
          hasData={Boolean(skills.data)}
          label="Skill 목록"
          onRetry={() => void skills.refetch()}
        />
      ) : null}

      <SectionCard title="사용 가능한 Skill" description="내 팀에 열려 있는 Skill과 최근 30일 성과입니다.">
        {available.length === 0 ? (
          <EmptyState
            title="사용 가능한 Skill이 없습니다."
            description="관리자가 Skill을 팀에 배포하면 여기에 나타납니다."
          />
        ) : (
          <ul className="access-list">
            {available.map((skill) => (
              <li key={skill.name}>
                <span className="access-list-title">
                  {skill.name}
                  <Badge tone={severityTone(skill.risk_level)}>{skill.risk_level || "위험도 미상"}</Badge>
                </span>
                <span className="access-list-detail">{skill.description}</span>
                <span className="access-list-detail">
                  30일 실행 {formatNumber(skill.runs_30d)} · 성공률 {formatSignedRatio(skill.success_rate)} ·
                  사용자 {formatNumber(skill.users_30d)} · 만족도 {formatNumber(skill.satisfaction, 1)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard title="요청 가능한 Skill" description="접근 권한을 신청해야 쓸 수 있는 Skill입니다.">
        <InlineNotice tone="info" title="접근 신청과 평가는 기존 화면에서 하세요.">
          이 UI 버전의 API 목록에 Skill 접근 신청과 평가 경로가 포함되어 있지 않습니다. 신청이 필요하면 기존
          관리자 화면의 Skills에서 진행하세요.
        </InlineNotice>
        {requestable.length === 0 ? (
          <EmptyState
            title="신청할 Skill이 없습니다."
            description="팀에 아직 열리지 않은 Skill이 생기면 여기에 표시됩니다."
          />
        ) : (
          <ul className="access-list">
            {requestable.map((skill) => (
              <li key={skill.name}>
                <span className="access-list-title">
                  {skill.name}
                  <Badge tone={severityTone(skill.risk_level)}>{skill.risk_level || "위험도 미상"}</Badge>
                </span>
                <span className="access-list-detail">{skill.description}</span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard
        title="내 추천"
        description="비용과 품질을 개선할 수 있는 제안입니다. 불러올 때마다 최신 상태로 다시 계산됩니다."
        actions={
          <Button
            variant="primary"
            disabled={recommendations.isFetching}
            onClick={() => setRecommendationsRequested(true)}
          >
            {recommendations.isFetching ? "불러오는 중" : "추천 불러오기"}
          </Button>
        }
      >
        {!recommendationsRequested ? (
          <p className="access-note">'추천 불러오기'를 누르면 내 사용 패턴을 다시 분석해 제안을 만듭니다.</p>
        ) : recommendations.isError ? (
          <QueryNotice
            error={recommendations.error}
            hasData={Boolean(recommendations.data)}
            label="추천"
            onRetry={() => void recommendations.refetch()}
          />
        ) : recommendationRows.length === 0 ? (
          <EmptyState
            title="지금은 제안할 항목이 없습니다."
            description="사용량이 더 쌓이면 절감이나 품질 개선 제안을 만들어 드립니다."
          />
        ) : (
          <ul className="access-list">
            {recommendationRows.map((row) => (
              <li key={row.id}>
                <span className="access-list-title">
                  {row.title}
                  <Badge tone="info">{row.kind}</Badge>
                </span>
                <span className="access-list-detail">{row.detail}</span>
                <span className="access-inline-actions">
                  <span className="access-list-detail">예상 절감 {formatKRW(row.est_savings_krw)}</span>
                  <Button
                    size="small"
                    onClick={() => feedback.mutate({ id: row.id, body: { action: "adopted" } })}
                  >
                    적용함
                  </Button>
                  <Button
                    size="small"
                    variant="ghost"
                    onClick={() => feedback.mutate({ id: row.id, body: { action: "later" } })}
                  >
                    나중에
                  </Button>
                  <Button
                    size="small"
                    variant="ghost"
                    onClick={() => feedback.mutate({ id: row.id, body: { action: "dismissed" } })}
                  >
                    필요 없음
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
