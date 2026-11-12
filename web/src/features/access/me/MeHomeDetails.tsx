import type { MeDashboard } from "@/shared/api/domains/me-console.schemas";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Badge } from "@/shared/components/ui/Badge";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { severityTone } from "@/features/access/access-format";
import { formatDateTime } from "@/shared/utils/format";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { MeTable } from "./MeTable";
import { meCost, meLabel, meNumber, meRatio } from "./me-console-model";
import { MePartial } from "./me-console-ui";

export function MeHomeDetails({ data }: { data: MeDashboard }) {
  const [, update] = useSearchState();
  return (
    <div className="access-stack">
      <MePartial failures={data.partial_failures} />
      <SectionCard title="자주 쓰는 모델" description="이번 달 시작(UTC) 이후의 상위 모델 최대 5개입니다.">
        <MeTable
          id="models"
          caption="자주 쓰는 모델"
          rows={data.frequent_models}
          columns={[
            { id: "model", header: "모델", value: (row) => row.model },
            { id: "requests", header: "요청", value: (row) => row.requests },
            {
              id: "cost",
              header: "평균 비용 (원)",
              value: (row) => row.avg_cost_krw,
              cell: (row) => meCost(row.avg_cost_krw),
            },
            {
              id: "success",
              header: "성공률",
              value: (row) => (row.requests ? row.success_rate : undefined),
              cell: (row) => meRatio(row.requests ? row.success_rate : undefined),
            },
          ]}
        />
      </SectionCard>
      <SectionCard
        title="최근 실패"
        description="최근 실패 요청 최대 5개입니다. 상세를 열면 본인 요청 영수증을 확인합니다."
      >
        <MeTable
          id="failures"
          caption="최근 실패 요청"
          rows={data.recent_failures}
          getRowId={(row) => row.id}
          columns={[
            { id: "id", header: "요청 ID", value: (row) => row.id },
            { id: "model", header: "모델", value: (row) => row.model },
            { id: "status", header: "상태 코드", value: (row) => row.status_code },
            { id: "error", header: "오류", value: (row) => row.error },
            {
              id: "created",
              header: "시각",
              value: (row) => row.created_at,
              cell: (row) => formatDateTime(row.created_at),
            },
          ]}
          onRowClick={(row) => update({ tab: "requests", receipt: row.id })}
          getRowActionLabel={(row) => row.id + " 영수증 열기"}
        />
      </SectionCard>
      <div className="me-home-columns">
        <SectionCard title="내 키 상태" description="만료 예정·장기 미사용 신호입니다.">
          {data.key_alerts.length ? (
            <ul className="access-list">
              {data.key_alerts.map((row) => (
                <li key={row.id}>
                  <span className="access-list-title">
                    <Badge tone={severityTone(row.severity)}>{meLabel(row.severity)}</Badge>
                    {row.name || row.id}
                  </span>
                  <span className="access-list-detail">
                    {row.flags.map(meLabel).join(", ") || "표시할 신호 없음"}
                    {row.expires_at ? ` · 만료 ${formatDateTime(row.expires_at)}` : ""}
                    {row.days_idle !== undefined && row.days_idle > 0
                      ? ` · ${meNumber(row.days_idle)}일 미사용`
                      : ""}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              title="주의할 키가 없습니다."
              description="현재 조회된 키 상태에 주의 신호가 없습니다."
            />
          )}
        </SectionCard>
        <SectionCard title="최근 차단" description="최근 정책 차단 최대 5개입니다.">
          {data.partial_failures.includes("blocks") ? (
            <p>차단 이력을 확인하지 못했습니다.</p>
          ) : data.recent_blocks.length ? (
            <ul className="access-list">
              {data.recent_blocks.map((row, index) => (
                <li key={index}>
                  <span className="access-list-title">{row.rule || "규칙 미상"}</span>
                  <span className="access-list-detail">{row.reason}</span>
                  <span className="access-list-detail">
                    {row.model} · {formatDateTime(row.created_at)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              title="저장된 차단 기록이 없습니다."
              description="조회한 범위에서 정책 차단 기록이 없습니다."
            />
          )}
        </SectionCard>
      </div>
      <SectionCard
        title="내 저장 리포트"
        description="본인이 만든 Text2SQL 리포트의 메타데이터 최대 5개입니다."
      >
        {data.partial_failures.includes("reports") ? (
          <p>저장 리포트를 확인하지 못했습니다.</p>
        ) : (
          <MeTable
            id="reports"
            caption="내 저장 리포트"
            rows={data.my_saved_reports}
            getRowId={(row) => row.id}
            columns={[
              { id: "name", header: "리포트", value: (row) => row.name },
              { id: "schema", header: "스키마", value: (row) => row.schema_name },
              { id: "kind", header: "종류", value: (row) => meLabel(row.kind) },
              { id: "status", header: "승인 상태", value: (row) => meLabel(row.approval_status) },
              {
                id: "created",
                header: "생성 시각",
                value: (row) => row.created_at,
                cell: (row) => formatDateTime(row.created_at),
              },
            ]}
          />
        )}
      </SectionCard>
      <div className="me-home-columns">
        <SectionCard title="추천 템플릿" description="사용 가능한 표준 템플릿의 메타데이터 최대 3개입니다.">
          <MeTable
            id="templates"
            caption="추천 템플릿"
            rows={data.recommended_templates}
            getRowId={(row) => row.id}
            columns={[
              { id: "name", header: "템플릿", value: (row) => row.name },
              { id: "category", header: "분류", value: (row) => row.category },
            ]}
          />
        </SectionCard>
        <SectionCard title="최근 프롬프트 제품" description="서버가 제공한 제품 메타데이터 최대 5개입니다.">
          <MeTable
            id="products"
            caption="최근 프롬프트 제품"
            rows={data.recent_prompt_products}
            getRowId={(row) => row.id}
            columns={[
              { id: "name", header: "제품", value: (row) => row.name },
              { id: "description", header: "설명", value: (row) => row.description },
            ]}
          />
        </SectionCard>
      </div>
    </div>
  );
}
