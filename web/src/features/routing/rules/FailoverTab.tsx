import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import {
  routingPatternsQueryKey,
  severityTone,
  writeScopeMessage,
} from "@/features/routing/rules/routing-shared";
import { QueryFailureNotice, ScopeNotice } from "@/features/routing/rules/routing-ui";
import { apiClient } from "@/shared/api/client";
import type { RoutingFailoverDrill, RoutingPatternAnalysis } from "@/shared/api/domains/routing";
import { endpoints } from "@/shared/api/endpoints";
import { isAppError } from "@/shared/api/error";
import { FormField } from "@/shared/components/form/FormField";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { Checkbox } from "@/shared/components/ui/Checkbox";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import { DataTable } from "@/shared/data-table/DataTable";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { formatNumber } from "@/shared/utils/format";

type CoverageRow = RoutingPatternAnalysis["coverage"][number];

const outcomeLabels: Record<string, string> = {
  served: "정상 처리",
  simulated_failure: "실패로 지정",
  skipped_breaker_open: "차단기 열림으로 건너뜀",
  skipped_health: "상태 저하로 건너뜀",
};

function coverageColumns(): ReadonlyArray<DataTableColumn<CoverageRow>> {
  const column = createDataTableColumnHelper<CoverageRow>();
  return column.columns([
    column.accessor((row) => row.provider, {
      id: "provider",
      header: "공급자",
      cell: ({ getValue }) => <strong>{getValue()}</strong>,
    }),
    column.accessor((row) => row.patterns.join(", "), {
      id: "patterns",
      header: "모델 패턴",
      cell: ({ getValue }) => <span className="mono truncate">{getValue() || "—"}</span>,
    }),
    column.accessor((row) => row.failover_group, {
      id: "group",
      header: "장애 전환 그룹",
      cell: ({ getValue }) => getValue() || "미지정",
    }),
    column.accessor((row) => row.failover_peers.join(", "), {
      id: "peers",
      header: "대체 공급자",
      cell: ({ getValue }) => <span className="truncate">{getValue() || "없음"}</span>,
    }),
    column.accessor((row) => row.failover_ready, {
      id: "ready",
      header: "폴백 준비",
      cell: ({ row, getValue }) =>
        getValue() ? (
          <Badge tone="success">
            {row.original.peer_source === "failover_group" ? "그룹 지정" : "패턴 중복"}
          </Badge>
        ) : (
          <Badge tone="danger">대체 없음</Badge>
        ),
    }),
  ]);
}

export function FailoverTab({ canWrite }: { canWrite: boolean }): React.JSX.Element {
  const [searchParams, updateSearch] = useSearchState();
  const model = searchParams.get("model") ?? "";
  const [modelInput, setModelInput] = useState(model);
  const [drillModel, setDrillModel] = useState("");
  const [failed, setFailed] = useState<readonly string[]>([]);
  const [drill, setDrill] = useState<RoutingFailoverDrill>();
  const [drillError, setDrillError] = useState<{ message: string; requestId?: string }>();
  const [drillPending, setDrillPending] = useState(false);

  const patterns = useQuery({
    queryKey: [...routingPatternsQueryKey, model],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.routing.patternConflicts, {
        query: model === "" ? undefined : { model },
        signal,
        routeId: "routing.rules",
      }),
  });
  const providers = useQuery({
    queryKey: ["routing", "providers"],
    queryFn: ({ signal }) => apiClient.request(endpoints.admin.providers.list, { signal }),
  });

  const summary = patterns.data?.summary;
  const coverage = patterns.data?.coverage ?? [];
  const simulation = patterns.data?.simulation ?? undefined;
  const unavailable = patterns.isPending || (patterns.isError && !patterns.data);

  const runDrill = async (): Promise<void> => {
    if (drillModel.trim() === "") return;
    setDrillPending(true);
    setDrillError(undefined);
    try {
      const result = await apiClient.request(endpoints.domains.routing.failoverDrill, {
        body: { model: drillModel.trim(), fail: failed },
      });
      setDrill(result);
    } catch (cause) {
      setDrill(undefined);
      setDrillError({
        message: safeAppErrorMessage(cause, "폴백 리허설을 실행하지 못했습니다."),
        requestId: isAppError(cause) ? cause.requestId : undefined,
      });
    } finally {
      setDrillPending(false);
    }
  };

  return (
    <div className="routing-panel-stack">
      {canWrite ? null : <ScopeNotice>{writeScopeMessage} 폴백 리허설도 실행할 수 없습니다.</ScopeNotice>}

      {patterns.isError ? (
        <QueryFailureNotice
          error={patterns.error}
          hasData={Boolean(patterns.data)}
          label="라우팅 패턴 분석"
          onRetry={() => void patterns.refetch()}
        />
      ) : null}

      <StatGrid label="장애 전환 요약">
        <StatCard label="공급자" value={unavailable ? "—" : formatNumber(summary?.provider_count)} />
        <StatCard label="모델 패턴" value={unavailable ? "—" : formatNumber(summary?.pattern_count)} />
        <StatCard
          label="패턴 충돌"
          tone={(summary?.conflict_count ?? 0) > 0 ? "warning" : "default"}
          value={unavailable ? "—" : formatNumber(summary?.conflict_count)}
        />
        <StatCard
          label="대체 공급자 없음"
          tone={(summary?.failover_uncovered_provider_count ?? 0) > 0 ? "danger" : "success"}
          value={unavailable ? "—" : formatNumber(summary?.failover_uncovered_provider_count)}
        />
      </StatGrid>

      <SectionCard
        title="모델 경로 확인"
        description="특정 모델 이름이 어떤 공급자로 가고, 실패하면 어디로 넘어가는지 확인합니다."
        actions={
          <Button variant="primary" onClick={() => updateSearch({ model: modelInput.trim() || undefined })}>
            경로 확인
          </Button>
        }
      >
        <div className="routing-form">
          <FormField label="모델 이름">
            {(control) => (
              <Input
                {...control}
                value={modelInput}
                placeholder="gpt-4.1"
                onChange={(event) => setModelInput(event.target.value)}
              />
            )}
          </FormField>
        </div>
        {simulation ? (
          <>
            <KeyValueList
              items={[
                { label: "모델", value: simulation.model, mono: true },
                { label: "선택 공급자", value: simulation.selected_provider || "기본 공급자" },
                { label: "선택 패턴", value: simulation.selected_pattern, mono: true },
                { label: "선택 사유", value: simulation.route_reason },
                {
                  label: "폴백 후보",
                  value:
                    simulation.failover_candidates.length > 0
                      ? simulation.failover_candidates.join(" → ")
                      : "없음",
                },
              ]}
            />
            {simulation.failover_available ? null : (
              <InlineNotice tone="warning" title="폴백이 없습니다.">
                {simulation.failover_blocked_reason ||
                  "이 모델은 대체 공급자가 없어 공급자 장애 시 요청이 그대로 실패합니다."}
              </InlineNotice>
            )}
            {simulation.ambiguous ? (
              <InlineNotice tone="warning" title="패턴이 겹칩니다.">
                여러 공급자가 같은 모델을 주장합니다. 우선순위에 따라 한 곳이 선택됩니다.
              </InlineNotice>
            ) : null}
          </>
        ) : (
          <EmptyState
            title="확인할 모델을 입력하세요."
            description="모델 이름을 넣으면 실제 라우팅이 고를 공급자와 폴백 후보를 계산합니다."
          />
        )}
      </SectionCard>

      <SectionCard
        title="장애 전환 커버리지"
        description="공급자별 대체 경로가 실제로 존재하는지 확인합니다."
      >
        <DataTable
          caption="공급자별 장애 전환 커버리지"
          columns={coverageColumns()}
          data={coverage}
          emptyMessage="등록된 공급자 패턴이 없습니다. 공급자에 모델 패턴을 지정하면 폴백 후보가 생깁니다."
          error={patterns.isError && !patterns.data ? "패턴 분석을 불러오지 못했습니다." : undefined}
          getRowId={(row) => row.provider}
          loading={patterns.isPending}
          onRetry={() => void patterns.refetch()}
        />
      </SectionCard>

      <SectionCard title="패턴 충돌" description="같은 모델을 두 공급자가 주장하면 라우팅 결과가 흔들립니다.">
        {(patterns.data?.conflicts.length ?? 0) === 0 ? (
          <EmptyState title="충돌이 없습니다." description="현재 모델 패턴은 서로 겹치지 않습니다." />
        ) : (
          <ul className="routing-steps">
            {(patterns.data?.conflicts ?? []).map((conflict) => (
              <li key={conflict.id}>
                <Badge tone={severityTone(conflict.severity)}>{conflict.severity}</Badge>
                <strong className="mono">{conflict.witness_model}</strong>
                <span className="routing-meta">
                  {conflict.candidates.map((candidate) => candidate.provider).join(", ")} →{" "}
                  {conflict.selected_provider} 선택 ({conflict.decision_reason})
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard
        title="폴백 리허설"
        description="지정한 공급자가 지금 죽었다고 가정하고 누가 요청을 받는지 계산합니다. 실제 호출은 하지 않습니다."
        actions={
          <Button
            variant="primary"
            disabled={!canWrite || drillPending || drillModel.trim() === ""}
            title={canWrite ? undefined : writeScopeMessage}
            onClick={() => void runDrill()}
          >
            {drillPending ? "실행 중" : "리허설 실행"}
          </Button>
        }
      >
        <div className="routing-form">
          <FormField label="모델 이름" required>
            {(control) => (
              <Input
                {...control}
                value={drillModel}
                placeholder="gpt-4.1"
                onChange={(event) => setDrillModel(event.target.value)}
              />
            )}
          </FormField>
        </div>
        <fieldset>
          <legend>실패로 지정할 공급자</legend>
          {(providers.data?.providers ?? []).map((provider) => (
            <Checkbox
              key={provider.provider_ref || provider.name}
              label={provider.name}
              checked={failed.includes(provider.name)}
              onChange={(event) =>
                setFailed((current) =>
                  event.target.checked
                    ? [...current, provider.name]
                    : current.filter((name) => name !== provider.name),
                )
              }
            />
          ))}
        </fieldset>
        {drillError ? (
          <InlineNotice tone="danger" title="폴백 리허설을 실행하지 못했습니다.">
            {drillError.message}
            {drillError.requestId ? ` 요청 ID: ${drillError.requestId}` : ""}
          </InlineNotice>
        ) : null}
        {drill ? (
          <>
            <KeyValueList
              items={[
                { label: "모델", value: drill.model, mono: true },
                { label: "결과", value: drill.served_by ? `${drill.served_by} 가 처리` : "처리 실패" },
                { label: "후보", value: drill.candidates.join(" → ") || "—" },
                { label: "상태 저하로 후순위", value: drill.health_demoted.join(", ") || "없음" },
              ]}
            />
            <ul className="routing-steps">
              {drill.steps.map((step, index) => (
                <li key={`${step.provider}-${index}`}>
                  <Badge tone={step.outcome === "served" ? "success" : "warning"}>
                    {outcomeLabels[step.outcome] ?? step.outcome}
                  </Badge>
                  <strong>{step.provider}</strong>
                  {step.detail ? <span className="routing-meta">{step.detail}</span> : null}
                </li>
              ))}
            </ul>
            {drill.advice ? (
              <InlineNotice
                tone={drill.outcome === "exhausted" ? "danger" : "warning"}
                title="점검이 필요합니다."
              >
                {drill.advice}
              </InlineNotice>
            ) : null}
          </>
        ) : null}
      </SectionCard>
    </div>
  );
}
