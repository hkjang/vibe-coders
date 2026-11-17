import { AppError } from "@/shared/api/error";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/shared/api/client";
import {
  withPathParams,
  type RedTeamCaseResult,
  type RedTeamRemediation,
} from "@/shared/api/domains/redteam";
import { endpoints } from "@/shared/api/endpoints";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Sheet } from "@/shared/components/ui/Sheet";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import { DataTable } from "@/shared/data-table/DataTable";
import { assertFeatureRead, featureOwnedKey } from "@/shared/hooks/use-feature-read-owner";
import { useRunHistoryOwner } from "./run-history-context";
import { PanelFailure } from "./RedTeamParts";
import { riskLabel } from "./redteam-labels";
import {
  decisionLabel,
  decisionTone,
  executionModeLabel,
  remediationLabel,
  remediationTone,
  riskTone,
  statusLabel,
} from "./redteam-ui";
import { redteamKeys, routeId } from "./use-redteam-data";
const redteam = endpoints.domains.redteam;
export function RunResultsSheet({
  canWrite,
  onClose,
  onCreateRemediation,
  onOpenEvidence,
  remediationByResult,
  returnFocusRef,
  runId,
  writeTitle,
}: {
  canWrite: boolean;
  onClose: () => void;
  onCreateRemediation: (resultId: string) => void;
  onOpenEvidence: (resultId: string, event: { currentTarget: HTMLElement }) => void;
  remediationByResult: ReadonlyMap<string, RedTeamRemediation>;
  returnFocusRef: React.RefObject<HTMLElement | null>;
  runId: string;
  writeTitle: string | undefined;
}): React.JSX.Element {
  const owner = useRunHistoryOwner();
  const results = useQuery({
    queryKey: owner ? featureOwnedKey(redteamKeys.runResults(runId), owner) : redteamKeys.runResults(runId),
    gcTime: 0,
    retry: false,
    queryFn: async ({ signal }) => {
      if (owner) assertFeatureRead(owner, signal);
      const result = await apiClient.request(withPathParams(redteam.runs.results, { id: runId }), {
        signal,
        routeId,
        cache: "no-store",
      });
      if (owner) assertFeatureRead(owner, signal);
      if (result.run.id !== runId)
        throw new AppError("선택한 실행의 결과를 확인하지 못했습니다.", { kind: "contract" });
      return result;
    },
    enabled: runId !== "",
  });
  const mode = results.data?.run.mode ?? "";
  const prompts = results.data?.prompts ?? {};

  return (
    <Sheet
      open={runId !== ""}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="레드팀 결과"
      description="증적에서 요청/응답을 확인하고, 위험하면 조치를 생성하세요."
      returnFocusRef={returnFocusRef}
      size="wide"
    >
      {results.data ? (
        <KeyValueList
          items={[
            { label: "실행 ID", value: results.data.run.id, mono: true },
            { label: "캠페인 ID", value: results.data.run.campaign_id, mono: true },
            { label: "실행 상태", value: statusLabel(results.data.run.status) },
            { label: "원본 결과 ID", value: results.data.run.source_result_id, mono: true },
            { label: "검토 ID", value: results.data.run.review_id, mono: true },
            { label: "실행 시각", value: results.data.run.created_at },
          ]}
        />
      ) : null}
      {results.data?.run.status === "stopped" ? (
        <InlineNotice tone="warning" title="중단된 실행의 일부 결과입니다.">
          아직 수행하지 않은 검사는 통과한 것으로 처리하지 않습니다. 이 실행은 통과 기준선을 갱신하지
          않습니다. 기록된 결과를 확인한 뒤 캠페인의 조건을 다시 검토하세요.
        </InlineNotice>
      ) : null}
      {mode !== "" && mode !== "active-controlled" ? (
        <InlineNotice tone="info" title={`이 실행은 ${executionModeLabel(mode)}(시뮬레이션)입니다.`}>
          실제 모델을 호출하지 않아 대상 응답은 시뮬레이션 표식입니다. 실제 요청/응답을 보려면 각 결과의
          증적에서 &lsquo;조건 검토 후 한 건 재실행&rsquo;을 사용하세요.
        </InlineNotice>
      ) : null}
      {results.isError ? (
        <PanelFailure
          error={results.error}
          hasData={Boolean(results.data)}
          label="실행 결과"
          onRetry={() => void results.refetch()}
        />
      ) : null}
      <DataTable
        caption="실행의 검사별 판정 결과"
        columns={resultColumns({
          canWrite,
          onCreateRemediation,
          onOpenEvidence,
          prompts,
          remediationByResult,
          writeTitle,
        })}
        data={results.data?.results ?? []}
        emptyMessage="결과가 없습니다."
        loading={runId !== "" && results.isPending}
      />
    </Sheet>
  );
}

function resultColumns({
  canWrite,
  onCreateRemediation,
  onOpenEvidence,
  prompts,
  remediationByResult,
  writeTitle,
}: {
  canWrite: boolean;
  onCreateRemediation: (resultId: string) => void;
  onOpenEvidence: (resultId: string, event: { currentTarget: HTMLElement }) => void;
  prompts: Readonly<Record<string, string>>;
  remediationByResult: ReadonlyMap<string, RedTeamRemediation>;
  writeTitle: string | undefined;
}): ReadonlyArray<DataTableColumn<RedTeamCaseResult>> {
  const column = createDataTableColumnHelper<RedTeamCaseResult>();
  return column.columns([
    column.accessor((row) => row.case_id, {
      id: "case_id",
      header: "검사",
      cell: ({ getValue }) => <code className="mono">{getValue()}</code>,
    }),
    column.accessor((row) => prompts[row.id] ?? "", {
      id: "prompt",
      header: "요청 프롬프트",
      cell: ({ getValue }) =>
        getValue() === "" ? (
          <span className="rt-muted">—</span>
        ) : (
          <span className="rt-template" title={getValue()}>
            {getValue()}
          </span>
        ),
    }),
    column.accessor((row) => row.decision, {
      id: "decision",
      header: "판정",
      cell: ({ getValue }) => <Badge tone={decisionTone(getValue())}>{decisionLabel(getValue())}</Badge>,
    }),
    column.accessor((row) => riskLabel(row.severity), {
      id: "severity",
      header: "심각도",
      cell: ({ row }) => (
        <Badge tone={riskTone(row.original.severity)}>{riskLabel(row.original.severity)}</Badge>
      ),
    }),
    column.accessor((row) => row.policy_decision, { id: "policy", header: "정책" }),
    column.display({
      id: "actions",
      header: "작업",
      cell: ({ row }) => {
        const remediation = remediationByResult.get(row.original.id);
        return (
          <div className="table-actions">
            <Button
              size="small"
              aria-label={`${row.original.case_id} 증적 보기`}
              onClick={(event) => onOpenEvidence(row.original.id, event)}
            >
              증적
            </Button>
            {remediation ? (
              <Badge tone={remediationTone(remediation.status)}>{remediationLabel(remediation.status)}</Badge>
            ) : (
              <Button
                size="small"
                disabled={!canWrite}
                title={writeTitle}
                aria-label={`${row.original.case_id} 조치 생성`}
                onClick={() => onCreateRemediation(row.original.id)}
              >
                조치
              </Button>
            )}
          </div>
        );
      },
    }),
  ]);
}
