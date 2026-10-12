import type { UseQueryResult } from "@tanstack/react-query";
import type { ApiEndpointOutput } from "@/shared/api/endpoint-factory";
import type { endpoints } from "@/shared/api/endpoints";
import type { McpUpstream, McpUpstreamProbe } from "@/shared/api/domains/mcp.schemas";
import { isAppError } from "@/shared/api/error";
import { QueryNotice } from "@/features/mcp/mcp-ui";
import { decisionLabel, decisionTone, listToCsv } from "@/features/mcp/mcp-utils";
import { Badge } from "@/shared/components/ui/Badge";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { DataTable } from "@/shared/data-table/DataTable";
import { formatDateTime, formatNumber } from "@/shared/utils/format";
import { stepColumns, runColumns, callColumns } from "./mcp-upstream-columns";

export function McpUpstreamDetails({
  selected,
  flow,
  probe,
}: {
  selected: McpUpstream;
  flow: UseQueryResult<ApiEndpointOutput<typeof endpoints.domains.mcp.upstreamFlow>, Error>;
  probe?: McpUpstreamProbe;
}): React.JSX.Element {
  const flowDenied = isAppError(flow.error) && [401, 403].includes(flow.error.status ?? 0);
  const flowData = flowDenied ? undefined : flow.data;
  const flowFinal = flowData?.final;
  return (
    <>
      {flow.isError ? (
        <QueryNotice
          error={flow.error}
          hasData={Boolean(flowData)}
          label="업스트림 흐름"
          onRetry={() => void flow.refetch()}
        />
      ) : null}
      <KeyValueList
        items={[
          { label: "업스트림 ID", value: selected.id, mono: true },
          { label: "엔드포인트", value: selected?.url ?? "—", mono: true },
          { label: "상태", value: selected?.enabled ? "사용" : "중지" },
          { label: "인증 토큰", value: selected?.has_auth ? "설정됨" : "없음" },
          { label: "위험도", value: selected?.metadata?.risk_level || "—" },
          { label: "승인 게이트", value: selected?.metadata?.requires_approval ? "필요" : "—" },
          { label: "설명", value: selected?.metadata?.description || "—" },
          { label: "도메인", value: listToCsv(selected?.metadata?.domains) || "—" },
          {
            label: "정책 판단",
            value: flowFinal ? (
              <Badge tone={decisionTone(flowFinal.decision)}>{decisionLabel(flowFinal.decision)}</Badge>
            ) : (
              "—"
            ),
          },
          { label: "판단 근거", value: flowFinal?.reason || "—" },
          { label: "등록 시각", value: formatDateTime(selected?.created_at) },
        ]}
      />

      {probe ? (
        <InlineNotice
          tone={probe.ok ? "success" : "danger"}
          title={probe.ok ? "연결 정상" : "도구 디스커버리 실패"}
        >
          <p>
            도구 {formatNumber(probe.tool_count)}개 · 프롬프트 {formatNumber(probe.prompt_count)}개 · 리소스{" "}
            {formatNumber(probe.resource_count)}개
          </p>
          {Object.entries(probe.errors).map(([capability, message]) => (
            <p key={capability} className="mono">
              {capability}: {message}
            </p>
          ))}
          {probe.tools.length > 0 ? (
            <p className="mono truncate">
              {probe.tools.map((discovered) => discovered.namespaced || discovered.name).join(", ")}
            </p>
          ) : null}
        </InlineNotice>
      ) : null}

      <SectionCard headingLevel={3} title="연결 단계" description="등록 → 사용 → 디스커버리 → 라우트 → 정책">
        <DataTable
          caption="업스트림 연결 단계"
          columns={stepColumns}
          data={flowData?.steps ?? []}
          loading={flow.isPending}
          getRowId={(row, index) => `${row.name}:${index}`}
        />
      </SectionCard>

      <SectionCard headingLevel={3} title="최근 디스커버리 실행">
        <DataTable
          caption="업스트림 디스커버리 실행 이력"
          columns={runColumns}
          data={flowData?.discovery_runs ?? []}
          getRowId={(row, index) => row.id || String(index)}
          emptyMessage="디스커버리 실행 기록이 없습니다."
        />
      </SectionCard>

      <SectionCard headingLevel={3} title="최근 MCP 호출">
        <DataTable
          caption="업스트림 최근 호출"
          columns={callColumns}
          data={flowData?.recent_requests ?? []}
          getRowId={(row, index) => row.id || String(index)}
          emptyMessage="최근 호출이 없습니다."
        />
      </SectionCard>

      {flowData?.discovery_error ? (
        <InlineNotice tone="danger" title="디스커버리 오류">
          <p className="mono">{flowData.discovery_error}</p>
        </InlineNotice>
      ) : null}
      {isAppError(flow.error) && flow.error.status === 404 ? (
        <InlineNotice tone="warning" title="업스트림을 찾을 수 없습니다.">
          이미 삭제되었을 수 있습니다. 목록을 새로고침하세요.
        </InlineNotice>
      ) : null}
    </>
  );
}
