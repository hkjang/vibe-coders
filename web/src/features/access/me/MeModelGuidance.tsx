import type { z } from "zod";
import type { meRecommendedModelsSchema } from "@/shared/api/domains/me-console.schemas";
import { MeTable } from "./MeTable";
import { meNumber } from "./me-console-model";

export function MeModelGuidance({ data }: { data: z.output<typeof meRecommendedModelsSchema> }) {
  return (
    <div className="access-stack">
      <h3 className="section-heading">내가 사용한 모델</h3>
      <MeTable
        id="model_guidance"
        caption="내 모델 용도"
        rows={data.your_models}
        columns={[
          { id: "model", header: "모델", value: (row) => row.model },
          {
            id: "requests",
            header: "30일 요청",
            value: (row) => row.requests,
            cell: (row) => meNumber(row.requests),
          },
          { id: "good_for", header: "권장 작업", value: (row) => row.tags?.good_for },
          { id: "avoid_for", header: "피할 작업", value: (row) => row.tags?.avoid_for },
          { id: "risk", header: "주의 사항", value: (row) => row.tags?.risk_note },
        ]}
      />
      <h3 className="section-heading">팀 평가 우수 모델</h3>
      {!data.partial_failures.includes("team_winners") ? (
        <MeTable
          id="team_winners"
          caption="팀 평가 우수 모델"
          rows={data.team_winners}
          description="최근 90일 팀의 다중 모델 평가에서 우승 횟수·평균 점수로 선정한 최대 3개 모델입니다."
          columns={[
            { id: "model", header: "모델", value: (row) => row.model },
            { id: "wins", header: "우승 횟수", value: (row) => row.wins },
            {
              id: "avg_score",
              header: "평균 점수",
              value: (row) => row.avg_score,
              cell: (row) => meNumber(row.avg_score, 1),
            },
            { id: "appearances", header: "평가 참여", value: (row) => row.appearances },
          ]}
        />
      ) : (
        <p className="access-note">팀 평가 결과를 조회하지 못했습니다. 다시 조회하세요.</p>
      )}
    </div>
  );
}
