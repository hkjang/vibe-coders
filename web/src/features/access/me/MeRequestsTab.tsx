import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";

import { httpTone, severityTone } from "@/features/access/access-format";
import { QueryNotice, UpdatedAt } from "@/features/access/access-ui";
import { useMeRecommendedModelsQuery, useMeRequestsQuery } from "@/features/access/me/use-me-queries";
import { apiClient } from "@/shared/api/client";
import type { MeRequest } from "@/shared/api/domains/access.schemas";
import { withPathParams } from "@/shared/api/endpoint-factory";
import { endpoints } from "@/shared/api/endpoints";
import { isAppError } from "@/shared/api/error";
import { LoadingState } from "@/shared/components/state/PageStates";
import { Badge } from "@/shared/components/ui/Badge";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { Sheet } from "@/shared/components/ui/Sheet";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import { DataTable } from "@/shared/data-table/DataTable";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { formatDateTime, formatDuration, formatKRW, formatNumber, shortId } from "@/shared/utils/format";

const access = endpoints.domains.access;
const routeId = "me.home";

function requestColumns(): ReadonlyArray<DataTableColumn<MeRequest>> {
  const column = createDataTableColumnHelper<MeRequest>();
  return column.columns([
    column.accessor((row) => row.created_at, {
      id: "created_at",
      header: "시각",
      cell: ({ getValue }) => formatDateTime(getValue()),
    }),
    column.accessor((row) => row.model, {
      id: "model",
      header: "모델",
      cell: ({ row }) => (
        <div>
          <strong className="truncate">{row.original.model || "—"}</strong>
          <div className="access-list-detail">{row.original.provider}</div>
        </div>
      ),
    }),
    column.accessor((row) => row.endpoint, {
      id: "endpoint",
      header: "엔드포인트",
      cell: ({ getValue }) => <span className="mono truncate">{getValue()}</span>,
    }),
    column.accessor((row) => row.status_code, {
      id: "status",
      header: "상태",
      cell: ({ getValue }) => <Badge tone={httpTone(getValue())}>{getValue() || "—"}</Badge>,
    }),
    column.accessor((row) => row.total_tokens, {
      id: "tokens",
      header: "토큰",
      cell: ({ getValue }) => <span className="cell-number">{formatNumber(getValue())}</span>,
    }),
    column.accessor((row) => row.cost_krw, {
      id: "cost",
      header: "비용",
      cell: ({ getValue }) => <span className="cell-number">{formatKRW(getValue())}</span>,
    }),
    column.accessor((row) => row.cached, {
      id: "cached",
      header: "캐시",
      cell: ({ getValue }) => (getValue() ? <Badge tone="success">적중</Badge> : "—"),
    }),
  ]);
}

export function MeRequestsTab(): React.JSX.Element {
  const [limit, setLimit] = useState(20);
  const requests = useMeRequestsQuery(limit, true);
  const models = useMeRecommendedModelsQuery(true);
  const [selected, setSelected] = useState("");
  const detailTrigger = useRef<HTMLElement>(null);

  const receipt = useQuery({
    queryKey: ["me", "receipt", selected],
    enabled: selected !== "",
    queryFn: ({ signal }) =>
      apiClient.request(withPathParams(access.me.receipt, { id: selected }), { signal, routeId }),
  });

  if (requests.isPending && !requests.data) {
    return <LoadingState label="최근 요청을 불러오는 중입니다." />;
  }

  const rows = requests.data?.requests ?? [];
  const recommendations = models.data;

  return (
    <div className="access-stack">
      {requests.isError ? (
        <QueryNotice
          error={requests.error}
          hasData={Boolean(requests.data)}
          label="최근 요청"
          onRetry={() => void requests.refetch()}
        />
      ) : null}

      <SectionCard
        title="최근 요청"
        description="행을 선택하면 요청 영수증(라우팅, 정책, 비용)을 볼 수 있습니다."
        actions={
          <label className="access-toolbar-field">
            <span>표시 개수</span>
            <Select value={String(limit)} onChange={(event) => setLimit(Number(event.target.value))}>
              <option value="20">20</option>
              <option value="50">50</option>
              <option value="100">100</option>
            </Select>
          </label>
        }
      >
        <DataTable
          caption="내 최근 요청"
          columns={requestColumns()}
          data={rows}
          getRowId={(row) => row.id}
          getRowActionLabel={(row) => `${shortId(row.id)} 영수증 열기`}
          onRowClick={(row) => {
            detailTrigger.current = document.activeElement as HTMLElement | null;
            setSelected(row.id);
          }}
          emptyMessage="최근 요청이 없습니다. 게이트웨이로 요청을 보내면 여기에 기록됩니다."
        />
        <UpdatedAt at={requests.dataUpdatedAt} />
      </SectionCard>

      <SectionCard title="추천 모델" description="내 작업 유형과 팀 결과를 바탕으로 한 추천입니다.">
        {models.isError ? (
          <QueryNotice
            error={models.error}
            hasData={Boolean(models.data)}
            label="추천 모델"
            onRetry={() => void models.refetch()}
          />
        ) : null}
        {recommendations && recommendations.task_recommendations.length === 0 ? (
          <EmptyState
            title="추천할 데이터가 아직 없습니다."
            description="요청이 쌓이면 작업 유형별로 적합한 모델을 알려 드립니다."
          />
        ) : null}
        {recommendations && recommendations.task_recommendations.length > 0 ? (
          <ul className="access-list">
            {recommendations.task_recommendations.map((row, index) => (
              <li key={`${row.task_type}-${String(index)}`}>
                <span className="access-list-title">
                  {row.task_type} · 요청 {formatNumber(row.requests)}
                </span>
                <span className="access-list-detail">
                  추천: {row.recommend.length > 0 ? row.recommend.join(", ") : "—"}
                </span>
                <span className="access-list-detail">
                  회피: {row.avoid.length > 0 ? row.avoid.join(", ") : "—"}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        {recommendations?.note ? <p className="access-note">{recommendations.note}</p> : null}
      </SectionCard>

      <Sheet
        open={selected !== ""}
        onOpenChange={(open) => {
          if (!open) setSelected("");
        }}
        returnFocusRef={detailTrigger}
        size="wide"
        title="요청 영수증"
        description="이 요청의 라우팅 결정, 정책 판정, 토큰과 비용 내역입니다."
      >
        {receipt.isPending ? <LoadingState label="영수증을 불러오는 중입니다." /> : null}
        {receipt.isError ? (
          <InlineNotice tone="danger" title="영수증을 불러오지 못했습니다.">
            {safeAppErrorMessage(receipt.error, "본인 요청만 조회할 수 있습니다.")}
            {isAppError(receipt.error) && receipt.error.requestId ? (
              <span className="request-id"> 요청 ID: {receipt.error.requestId}</span>
            ) : null}
          </InlineNotice>
        ) : null}
        {receipt.data ? (
          <div className="access-stack">
            <KeyValueList
              items={[
                { label: "요청 ID", value: receipt.data.request_id, mono: true },
                { label: "시각", value: formatDateTime(receipt.data.created_at) },
                { label: "엔드포인트", value: receipt.data.endpoint, mono: true },
                { label: "모델", value: receipt.data.model },
                { label: "공급자", value: receipt.data.provider },
                { label: "상태 코드", value: receipt.data.status_code || "—" },
                { label: "종료 사유", value: receipt.data.finish_reason },
                { label: "지연", value: formatDuration(receipt.data.latency_ms) },
                { label: "비용", value: formatKRW(receipt.data.cost_krw) },
                { label: "캐시 적중", value: receipt.data.cache_hit ? "예" : "아니오" },
                { label: "차단", value: receipt.data.blocked ? "예" : "아니오" },
              ]}
            />
            {receipt.data.tokens ? (
              <SectionCard title="토큰" headingLevel={3}>
                <KeyValueList
                  items={[
                    { label: "프롬프트", value: formatNumber(receipt.data.tokens.prompt) },
                    { label: "응답", value: formatNumber(receipt.data.tokens.completion) },
                    { label: "합계", value: formatNumber(receipt.data.tokens.total) },
                    { label: "캐시", value: formatNumber(receipt.data.tokens.cached) },
                  ]}
                />
              </SectionCard>
            ) : null}
            {receipt.data.routing ? (
              <SectionCard title="라우팅" headingLevel={3}>
                <KeyValueList
                  items={[
                    { label: "요청 모델", value: receipt.data.routing.requested_model },
                    { label: "선택 모델", value: receipt.data.routing.selected_model },
                    { label: "선택 공급자", value: receipt.data.routing.selected_provider },
                    { label: "선택 사유", value: receipt.data.routing.reason },
                    { label: "위험 등급", value: receipt.data.routing.risk_tier },
                    { label: "복잡도 등급", value: receipt.data.routing.complexity_tier },
                    {
                      label: "장애 전환 경로",
                      value: receipt.data.routing.fallback_path.join(" → "),
                    },
                  ]}
                />
              </SectionCard>
            ) : null}
            <SectionCard title="정책 판정" headingLevel={3}>
              {receipt.data.policy.length === 0 ? (
                <p className="access-note">적용된 정책 판정이 없습니다.</p>
              ) : (
                <ul className="access-list">
                  {receipt.data.policy.map((row, index) => (
                    <li key={`${row.rule}-${String(index)}`}>
                      <span className="access-list-title">
                        <Badge tone={severityTone(row.decision)}>{row.decision || "—"}</Badge>
                        {row.rule}
                      </span>
                      <span className="access-list-detail">{row.reason}</span>
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>
            <SectionCard title="MCP 도구와 Skill" headingLevel={3}>
              <KeyValueList
                items={[
                  { label: "MCP 사용", value: receipt.data.mcp_used ? "예" : "아니오" },
                  {
                    label: "MCP 도구",
                    value:
                      receipt.data.mcp_tools.length === 0
                        ? "—"
                        : receipt.data.mcp_tools
                            .map((tool) => `${tool.server}/${tool.tool}${tool.error ? " (오류)" : ""}`)
                            .join(", "),
                  },
                  { label: "Skill 사용", value: receipt.data.skill_used ? "예" : "아니오" },
                  { label: "Skill", value: receipt.data.skills.join(", ") },
                ]}
              />
            </SectionCard>
            {receipt.data.note ? <p className="access-note">{receipt.data.note}</p> : null}
          </div>
        ) : null}
      </Sheet>
    </div>
  );
}
