import { RedTeamEvidenceSheet } from "./RedTeamEvidenceSheet";
import { riskLabel } from "./redteam-labels";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { PanelFailure } from "@/features/security/redteam/RedTeamParts";
import {
  decisionLabel,
  decisionTone,
  executionModeLabel,
  isRemediationClosed,
  remediationLabel,
  remediationTone,
  riskTone,
  scoreTone,
  statusTone,
  statusLabel,
  writeDeniedReason,
} from "@/features/security/redteam/redteam-ui";
import { redteamKeys, routeId, type RedTeamData } from "@/features/security/redteam/use-redteam-data";
import { useReturnFocus } from "@/shared/hooks/use-return-focus";
import { apiClient } from "@/shared/api/client";
import {
  withPathParams,
  type RedTeamBaseline,
  type RedTeamCaseResult,
  type RedTeamRemediation,
  type RedTeamRun,
} from "@/shared/api/domains/redteam";
import { endpoints } from "@/shared/api/endpoints";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Sheet } from "@/shared/components/ui/Sheet";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import { DataTable } from "@/shared/data-table/DataTable";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { formatNumber, formatRelative } from "@/shared/utils/format";

const redteam = endpoints.domains.redteam;

interface RunsTabProps {
  canWrite: boolean;
  data: RedTeamData;
  onOpenRun: (runId: string) => void;
  openRunId: string;
  proxyKey: string;
}

export function RedTeamRunsTab({
  canWrite,
  data,
  onOpenRun,
  openRunId,
  proxyKey,
}: RunsTabProps): React.JSX.Element {
  const { baselines, remediations, runs } = data;
  const { remember, returnFocusRef } = useReturnFocus();
  const [openResultId, setOpenResultId] = useState("");
  const [pendingApply, setPendingApply] = useState<RedTeamRemediation | undefined>();
  const writeTitle = canWrite ? undefined : writeDeniedReason;

  const remediationByResult = new Map(
    (remediations.data?.remediations ?? []).map((item) => [item.result_id, item]),
  );

  const updateRemediation = useMutationFeedback({
    mutate: ({ id, status }: { id: string; status: string }) =>
      apiClient.request(withPathParams(redteam.remediations.update, { id }), {
        body: { status },
        routeId,
      }),
    invalidates: [redteamKeys.remediations, redteamKeys.dashboard],
    successMessage: "조치 상태를 변경했습니다.",
    errorMessage: "조치 상태를 변경하지 못했습니다.",
  });

  const applyRemediation = useMutationFeedback({
    mutate: (remediation: RedTeamRemediation) =>
      apiClient.request(withPathParams(redteam.remediations.apply, { id: remediation.id }), {
        routeId,
      }),
    invalidates: [redteamKeys.remediations, redteamKeys.dashboard],
    successMessage: (result) => result.outcome || "조치를 적용했습니다.",
    errorMessage: "조치를 적용하지 못했습니다.",
  });

  const createRemediation = useMutationFeedback({
    mutate: (resultId: string) =>
      apiClient.request(withPathParams(redteam.results.remediation, { id: resultId }), {
        body: { action_type: "owner_action", action_payload: { source: "app_console" } },
        routeId,
      }),
    invalidates: [redteamKeys.remediations, redteamKeys.dashboard],
    successMessage: "이 결과에 대한 조치를 생성했습니다.",
    errorMessage: "조치를 생성하지 못했습니다.",
  });

  return (
    <div className="rt-stack">
      {runs.isError ? (
        <PanelFailure
          error={runs.error}
          hasData={Boolean(runs.data)}
          label="실행 이력"
          onRetry={() => void runs.refetch()}
        />
      ) : null}

      <SectionCard
        title="실행 이력"
        description="실행 상태와 위험 점수입니다. 중단된 실행은 일부 검사 결과만 포함할 수 있습니다."
      >
        <DataTable
          caption="레드팀 캠페인 실행 이력"
          columns={runColumns((run, event) => {
            remember(event);
            onOpenRun(run.id);
          })}
          data={runs.data?.runs ?? []}
          emptyMessage="실행 이력이 없습니다. 캠페인 탭에서 캠페인을 실행하면 채워집니다."
          error={runs.isError && !runs.data ? "실행 이력을 불러오지 못했습니다." : undefined}
          loading={runs.isPending}
          onRetry={() => void runs.refetch()}
        />
      </SectionCard>

      <div className="rt-grid-2">
        <SectionCard
          title="기준선 앵커"
          description="통과한 실행이 대상×묶음별 기준 점수로 저장되어 회귀(드리프트)를 감지합니다."
        >
          <DataTable
            caption="대상별 기준선 앵커"
            columns={baselineColumns()}
            data={baselines.data?.baselines ?? []}
            emptyMessage="기준선이 없습니다. 통과한 실행이 생기면 기록됩니다."
            loading={baselines.isPending}
          />
        </SectionCard>

        <SectionCard
          title="조치 보드"
          description="'적용'은 지원 유형(MCP 도구 신뢰도)을 실제 반영하고, 그 외는 초안을 생성한 뒤 담당자가 확정합니다."
        >
          <DataTable
            caption="레드팀 결과에 대한 조치 목록"
            columns={remediationColumns({
              canWrite,
              onApply: (remediation, event) => {
                remember(event);
                setPendingApply(remediation);
              },
              onStatus: (remediation, status) => updateRemediation.mutate({ id: remediation.id, status }),
            })}
            data={remediations.data?.remediations ?? []}
            emptyMessage="조치가 없습니다. 결과 목록에서 조치를 생성할 수 있습니다."
            loading={remediations.isPending}
          />
        </SectionCard>
      </div>

      <RunResultsSheet
        canWrite={canWrite}
        onClose={() => onOpenRun("")}
        onCreateRemediation={(resultId) => createRemediation.mutate(resultId)}
        onOpenEvidence={(resultId, event) => {
          remember(event);
          setOpenResultId(resultId);
        }}
        remediationByResult={remediationByResult}
        returnFocusRef={returnFocusRef}
        runId={openRunId}
        writeTitle={writeTitle}
      />

      <RedTeamEvidenceSheet
        onOpenRun={onOpenRun}
        canWrite={canWrite}
        onClose={() => setOpenResultId("")}
        onCreateRemediation={(resultId) => createRemediation.mutate(resultId)}
        proxyKey={proxyKey}
        resultId={openResultId}
        returnFocusRef={returnFocusRef}
        writeTitle={writeTitle}
      />

      <ConfirmDialog
        open={pendingApply !== undefined}
        onOpenChange={(open) => {
          if (!open) setPendingApply(undefined);
        }}
        title="조치 적용"
        description="이 조치를 실제로 적용합니다. MCP 도구 신뢰도 상향 등 실제 정책 변경이 발생할 수 있습니다."
        confirmLabel="적용"
        tone="danger"
        returnFocusRef={returnFocusRef}
        onConfirm={() => (pendingApply ? applyRemediation.mutateAsync(pendingApply) : undefined)}
      />
    </div>
  );
}

function RunResultsSheet({
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
  const results = useQuery({
    queryKey: redteamKeys.runResults(runId),
    queryFn: ({ signal }) =>
      apiClient.request(withPathParams(redteam.runs.results, { id: runId }), { signal, routeId }),
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

function runColumns(
  onOpen: (run: RedTeamRun, event: { currentTarget: HTMLElement }) => void,
): ReadonlyArray<DataTableColumn<RedTeamRun>> {
  const column = createDataTableColumnHelper<RedTeamRun>();
  return column.columns([
    column.accessor((row) => row.id, {
      id: "id",
      header: "실행",
      cell: ({ row }) => (
        <div className="rt-stacked-cell">
          <code className="mono">{row.original.id}</code>
          {row.original.source_result_id ? (
            <span>
              한 건 재실행 · 원본 <code>{row.original.source_result_id}</code>
            </span>
          ) : null}
          <span title={row.original.created_at || undefined}>
            {formatRelative(row.original.created_at || null)}
          </span>
        </div>
      ),
    }),
    column.accessor((row) => row.campaign_id, {
      id: "campaign_id",
      header: "캠페인",
      cell: ({ getValue }) => <code className="mono">{getValue()}</code>,
    }),
    column.accessor((row) => row.target_id, {
      id: "target_id",
      header: "대상",
      cell: ({ getValue }) => <code className="mono">{getValue()}</code>,
    }),
    column.accessor((row) => row.status, {
      id: "status",
      header: "상태",
      cell: ({ getValue }) => <Badge tone={statusTone(getValue())}>{statusLabel(getValue())}</Badge>,
    }),
    column.accessor((row) => row.failed_cases, {
      id: "cases",
      header: "실패/전체",
      cell: ({ row }) => (
        <span className="cell-number">
          {formatNumber(row.original.failed_cases)} / {formatNumber(row.original.total_cases)}
        </span>
      ),
    }),
    column.accessor((row) => row.risk_score, {
      id: "risk_score",
      header: "위험",
      cell: ({ getValue }) => <Badge tone={scoreTone(getValue())}>{formatNumber(getValue())}</Badge>,
    }),
    column.display({
      id: "actions",
      header: "작업",
      cell: ({ row }) => (
        <Button
          size="small"
          aria-label={`${row.original.id} 결과 보기`}
          onClick={(event) => onOpen(row.original, event)}
        >
          결과
        </Button>
      ),
    }),
  ]);
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

function baselineColumns(): ReadonlyArray<DataTableColumn<RedTeamBaseline>> {
  const column = createDataTableColumnHelper<RedTeamBaseline>();
  return column.columns([
    column.accessor((row) => row.target_id, {
      id: "target_id",
      header: "대상",
      cell: ({ getValue }) => <code className="mono">{getValue()}</code>,
    }),
    column.accessor((row) => row.pack_id, {
      id: "pack_id",
      header: "묶음",
      cell: ({ getValue }) => <code className="mono">{getValue()}</code>,
    }),
    column.accessor((row) => row.baseline_score, {
      id: "baseline_score",
      header: "기준 점수",
      cell: ({ getValue }) => <span className="cell-number">{formatNumber(getValue())}</span>,
    }),
    column.accessor((row) => row.drift_threshold, {
      id: "drift_threshold",
      header: "드리프트 임계",
      cell: ({ getValue }) => <span className="cell-number">{formatNumber(getValue())}</span>,
    }),
    column.accessor((row) => row.last_passed_at || row.updated_at, {
      id: "last_passed_at",
      header: "최근 통과",
      cell: ({ getValue }) => (
        <span title={getValue() || undefined}>{formatRelative(getValue() || null)}</span>
      ),
    }),
  ]);
}

function remediationColumns({
  canWrite,
  onApply,
  onStatus,
}: {
  canWrite: boolean;
  onApply: (remediation: RedTeamRemediation, event: { currentTarget: HTMLElement }) => void;
  onStatus: (remediation: RedTeamRemediation, status: string) => void;
}): ReadonlyArray<DataTableColumn<RedTeamRemediation>> {
  const column = createDataTableColumnHelper<RedTeamRemediation>();
  const writeTitle = canWrite ? undefined : writeDeniedReason;
  return column.columns([
    column.accessor((row) => row.action_type, { id: "action_type", header: "조치 유형" }),
    column.accessor((row) => row.result_id, {
      id: "result_id",
      header: "결과 ID",
      cell: ({ getValue }) => <code className="mono">{getValue()}</code>,
    }),
    column.accessor((row) => row.status, {
      id: "status",
      header: "상태",
      cell: ({ getValue }) => (
        <Badge tone={remediationTone(getValue())}>{remediationLabel(getValue())}</Badge>
      ),
    }),
    column.accessor((row) => row.owner, {
      id: "owner",
      header: "담당",
      cell: ({ getValue }) => getValue() || "—",
    }),
    column.accessor((row) => row.created_at, {
      id: "created_at",
      header: "생성",
      cell: ({ getValue }) => (
        <span title={getValue() || undefined}>{formatRelative(getValue() || null)}</span>
      ),
    }),
    column.display({
      id: "actions",
      header: "작업",
      cell: ({ row }) => {
        const remediation = row.original;
        const label = remediation.action_type || remediation.id;
        if (isRemediationClosed(remediation.status)) {
          return (
            <Button
              size="small"
              disabled={!canWrite}
              title={writeTitle}
              aria-label={`${label} 조치 재개`}
              onClick={() => onStatus(remediation, "open")}
            >
              재개
            </Button>
          );
        }
        return (
          <div className="table-actions">
            <Button
              size="small"
              variant="primary"
              disabled={!canWrite}
              title={writeTitle}
              aria-label={`${label} 조치 적용`}
              onClick={(event) => onApply(remediation, event)}
            >
              적용
            </Button>
            <Button
              size="small"
              disabled={!canWrite}
              title={writeTitle}
              aria-label={`${label} 조치 완료`}
              onClick={() => onStatus(remediation, "resolved")}
            >
              완료
            </Button>
            <Button
              size="small"
              disabled={!canWrite}
              title={writeTitle}
              aria-label={`${label} 조치 기각`}
              onClick={() => onStatus(remediation, "dismissed")}
            >
              기각
            </Button>
          </div>
        );
      },
    }),
  ]);
}
