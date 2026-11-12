import { useState } from "react";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Button } from "@/shared/components/ui/Button";
import { Badge } from "@/shared/components/ui/Badge";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { useMeRecommendationsQuery } from "./use-me-queries";
import { useMeGenerateRecommendations, useMeRecommendationFeedback } from "./me-console-actions";
import { MeOperationNotice, MeQueryContent } from "./me-console-ui";
import { meCost, meLabel } from "./me-console-model";
import type { RecommendationFeedbackBody } from "@/shared/api/domains/access";

export function MeRecommendations() {
  const query = useMeRecommendationsQuery();
  const generate = useMeGenerateRecommendations();
  const feedback = useMeRecommendationFeedback();
  const [recorded, setRecorded] = useState<Readonly<Record<string, string>>>({});
  const actions: readonly RecommendationFeedbackBody["action"][] = ["adopted", "later", "dismissed"];
  return (
    <SectionCard
      title="내 추천"
      description="저장된 추천을 보여 줍니다. 새로 계산하면 현재 사용량을 기준으로 저장된 추천 목록을 바꿉니다."
      actions={
        <Button
          variant="primary"
          disabled={generate.disabled || query.isFetching}
          onClick={() => void generate.execute(undefined).catch(() => undefined)}
        >
          {generate.pending ? "계산 중" : "추천 새로 계산"}
        </Button>
      }
    >
      {!generate.access.allowed ? (
        <InlineNotice tone="info">읽기 전용에서는 저장된 추천만 조회할 수 있습니다.</InlineNotice>
      ) : null}
      <MeOperationNotice
        pending={generate.pending || feedback.pending}
        uncertain={generate.uncertain || feedback.uncertain}
      />
      <MeQueryContent query={query} label="저장된 추천">
        {query.data?.recommendations.length ? (
          <ul className="access-list">
            {query.data.recommendations.map((row) => (
              <li key={row.id}>
                <span className="access-list-title">
                  {row.title}
                  <Badge tone="info">{meLabel(row.kind)}</Badge>
                </span>
                <span className="access-list-detail">{row.detail}</span>
                <span className="access-list-detail">예상 절감 {meCost(row.est_savings_krw)}</span>
                {recorded[row.id] ? (
                  <p role="status">이 화면에서 기록한 의견: {recorded[row.id]}</p>
                ) : (
                  <span className="access-inline-actions">
                    {actions.map((action) => (
                      <Button
                        key={action}
                        size="small"
                        variant={action === "adopted" ? "secondary" : "ghost"}
                        disabled={feedback.disabled || query.isFetching}
                        onClick={() =>
                          void feedback
                            .execute({ id: row.id, kind: row.kind, action })
                            .then(() => setRecorded((value) => ({ ...value, [row.id]: meLabel(action) })))
                            .catch(() => undefined)
                        }
                      >
                        {meLabel(action)}
                      </Button>
                    ))}
                  </span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            title="저장된 추천이 없습니다."
            description="추천 새로 계산을 누르면 사용 패턴에 따른 절감·품질 개선 제안을 저장합니다."
          />
        )}
      </MeQueryContent>
    </SectionCard>
  );
}
