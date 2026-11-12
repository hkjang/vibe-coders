import { useRef } from "react";
import { Link } from "react-router";
import { httpTone } from "@/features/access/access-format";
import { UpdatedAt } from "@/features/access/access-ui";
import { useMeRecommendedModelsQuery, useMeRequestsQuery } from "./use-me-queries";
import type { MeRequest } from "@/shared/api/domains/me-console.schemas";
import { Badge } from "@/shared/components/ui/Badge";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { FormField } from "@/shared/components/form/FormField";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { formatDateTime } from "@/shared/utils/format";
import { MeTable, type MeColumn } from "./MeTable";
import { MeQueryContent, MePartial } from "./me-console-ui";
import { meCost, meNumber } from "./me-console-model";
import { MeReceiptSheet } from "./MeReceiptSheet";
import { MeModelGuidance } from "./MeModelGuidance";

export function MeRequestsTab() {
  const [params, update] = useSearchState();
  const limit = [20, 50, 100].find((value) => value === Number(params.get("limit"))) ?? 20;
  const status = ["success", "error"].find((value) => value === params.get("request_status")) ?? "all";
  const requests = useMeRequestsQuery(limit, true);
  const models = useMeRecommendedModelsQuery(true);
  const selected = params.get("receipt") ?? "";
  const trigger = useRef<HTMLElement>(null);
  const rows = (requests.data?.requests ?? []).filter(
    (row) =>
      status === "all" ||
      (row.status_code !== undefined &&
        (status === "error" ? row.status_code >= 400 : row.status_code >= 200 && row.status_code < 400)),
  );
  const columns: readonly MeColumn<MeRequest>[] = [
    {
      id: "id",
      header: "요청 ID",
      value: (row) => row.id,
      cell: (row) => {
        const next = new URLSearchParams(params);
        next.set("receipt", row.id);
        return (
          <Link
            className="me-receipt-link mono"
            to={"?" + next.toString()}
            onClick={(event) => {
              trigger.current = event.currentTarget;
            }}
          >
            {row.id}
          </Link>
        );
      },
    },
    {
      id: "created_at",
      header: "시각",
      value: (row) => row.created_at,
      cell: (row) => formatDateTime(row.created_at),
    },
    { id: "model", header: "모델", value: (row) => row.model },
    { id: "provider", header: "공급자", value: (row) => row.provider },
    { id: "endpoint", header: "엔드포인트", value: (row) => row.endpoint },
    {
      id: "status",
      header: "상태 코드",
      value: (row) => row.status_code,
      cell: (row) => <Badge tone={httpTone(row.status_code ?? 0)}>{row.status_code ?? "미확인"}</Badge>,
    },
    {
      id: "tokens",
      header: "토큰",
      value: (row) => row.total_tokens,
      cell: (row) => meNumber(row.total_tokens),
    },
    { id: "cost", header: "비용 (원)", value: (row) => row.cost_krw, cell: (row) => meCost(row.cost_krw) },
    {
      id: "cached",
      header: "캐시",
      value: (row) => (row.cached === undefined ? undefined : row.cached ? "적중" : "미적중"),
    },
  ];
  return (
    <div className="access-stack">
      <SectionCard
        title="최근 요청"
        description="내 최근 요청의 안전한 메타데이터입니다. 요청 ID를 선택하면 영수증을 엽니다."
      >
        <div className="me-filter-controls">
          <FormField label="서버에서 가져올 최대 요청 수">
            {(control) => (
              <Select
                {...control}
                value={String(limit)}
                onChange={(event) => update({ limit: event.target.value, requests_page: undefined })}
              >
                {[20, 50, 100].map((value) => (
                  <option key={value} value={value}>
                    {value}건
                  </option>
                ))}
              </Select>
            )}
          </FormField>
          <FormField label="요청 상태">
            {(control) => (
              <Select
                {...control}
                value={status}
                onChange={(event) =>
                  update({
                    request_status: event.target.value === "all" ? undefined : event.target.value,
                    requests_page: undefined,
                  })
                }
              >
                <option value="all">전체</option>
                <option value="success">정상 (200–399)</option>
                <option value="error">오류 (400 이상)</option>
              </Select>
            )}
          </FormField>
        </div>
        <MeQueryContent query={requests} label="최근 요청">
          <MeTable
            id="requests"
            caption="내 최근 요청"
            rows={rows}
            columns={columns}
            getRowId={(row) => row.id}
            description={`최근 최대 ${limit}건 안에서 조회합니다. 전체 요청 이력을 뜻하지 않습니다.`}
            loading={requests.isFetching}
            onRowClick={(row) => {
              trigger.current = document.activeElement as HTMLElement | null;
              update({ receipt: row.id });
            }}
            getRowActionLabel={(row) => row.id + " 영수증 열기"}
          />
          <UpdatedAt at={requests.dataUpdatedAt} />
        </MeQueryContent>
      </SectionCard>
      <SectionCard
        title="추천 모델"
        description="개인 작업 유형과 팀 평가 결과에 따른 모델 선택 참고 정보입니다."
      >
        <MeQueryContent query={models} label="추천 모델">
          <MePartial failures={models.data?.partial_failures} />
          {models.data?.task_recommendations.length ? (
            <ul className="access-list">
              {models.data.task_recommendations.map((row, index) => (
                <li key={index}>
                  <span className="access-list-title">
                    {row.task_type} · 요청 {meNumber(row.requests)}
                  </span>
                  <span className="access-list-detail">
                    추천: {row.recommend.join(", ") || "—"} · 회피: {row.avoid.join(", ") || "—"}
                  </span>
                </li>
              ))}
            </ul>
          ) : !models.data?.partial_failures.length ? (
            <EmptyState
              title="추천할 데이터가 아직 없습니다."
              description="요청이 쌓이면 작업 유형별 추천을 확인할 수 있습니다."
            />
          ) : null}
          {models.data?.note ? <p className="access-note">{models.data.note}</p> : null}
          {models.data ? <MeModelGuidance data={models.data} /> : null}
        </MeQueryContent>
      </SectionCard>
      <MeReceiptSheet selected={selected} close={() => update({ receipt: undefined })} trigger={trigger} />
    </div>
  );
}
