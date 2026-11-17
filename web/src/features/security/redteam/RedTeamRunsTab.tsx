import { useRedTeamMutation } from "./use-redteam-mutation";
import { useAuth } from "@/app/auth/AuthProvider";
import { versionAtLeast } from "@/config/migration-registry";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { runFilterKeys } from "@/shared/utils/redteam-run-query";
import { RedTeamRunExplorer } from "./RedTeamRunExplorer";
import { RunResultsSheet } from "./RunResultsSheet";
import { runColumns } from "./run-columns";
import { RedTeamEvidenceSheet } from "./RedTeamEvidenceSheet";
import { useState } from "react";

import { PanelFailure } from "@/features/security/redteam/RedTeamParts";
import {
  isRemediationClosed,
  remediationLabel,
  remediationTone,
  writeDeniedReason,
} from "@/features/security/redteam/redteam-ui";
import { redteamKeys, routeId, type RedTeamData } from "@/features/security/redteam/use-redteam-data";
import { useReturnFocus } from "@/shared/hooks/use-return-focus";
import { apiClient } from "@/shared/api/client";
import { withPathParams, type RedTeamBaseline, type RedTeamRemediation } from "@/shared/api/domains/redteam";
import { endpoints } from "@/shared/api/endpoints";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import { DataTable } from "@/shared/data-table/DataTable";
import { formatNumber, formatRelative } from "@/shared/utils/format";

const redteam = endpoints.domains.redteam;

interface RunsTabProps {
  canWrite: boolean;
  writeReason?: string;
  data: RedTeamData;
  onOpenRun: (runId: string) => void;
  openRunId: string;
  proxyKey: string;
}

export function RedTeamRunsTab({
  canWrite,
  writeReason = writeDeniedReason,
  data,
  onOpenRun,
  openRunId,
  proxyKey,
}: RunsTabProps): React.JSX.Element {
  const { baselines, remediations, runs } = data;
  const { backendVersion } = useAuth();
  const [, updateSearch] = useSearchState();
  const paged = versionAtLeast(backendVersion, "v0.86.145");
  const { remember, returnFocusRef } = useReturnFocus();
  const [openResultId, setOpenResultId] = useState("");
  const [evidenceFocusId, setEvidenceFocusId] = useState("");
  const evidenceFocus = useReturnFocus();
  const [pendingApply, setPendingApply] = useState<RedTeamRemediation | undefined>();
  const writeTitle = canWrite ? undefined : writeReason;

  const remediationByResult = new Map(
    (remediations.data?.remediations ?? []).map((item) => [item.result_id, item]),
  );

  const updateRemediation = useRedTeamMutation(canWrite, {
    mutate: ({ id, status }: { id: string; status: string }) =>
      apiClient.request(withPathParams(redteam.remediations.update, { id }), {
        body: { status },
        routeId,
      }),
    invalidates: [redteamKeys.remediations, redteamKeys.dashboard],
    successMessage: "조치 상태를 변경했습니다.",
    errorMessage: "조치 상태를 변경하지 못했습니다.",
  });

  const applyRemediation = useRedTeamMutation(canWrite, {
    mutate: (remediation: RedTeamRemediation) =>
      apiClient.request(withPathParams(redteam.remediations.apply, { id: remediation.id }), {
        routeId,
      }),
    invalidates: [redteamKeys.remediations, redteamKeys.dashboard],
    successMessage: (result) => result.outcome || "조치를 적용했습니다.",
    errorMessage: "조치를 적용하지 못했습니다.",
  });

  const createRemediation = useRedTeamMutation(canWrite, {
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
      {!paged && runs.isError ? (
        <PanelFailure
          error={runs.error}
          hasData={Boolean(runs.data)}
          label="실행 이력"
          onRetry={() => void runs.refetch()}
        />
      ) : null}

      {paged ? (
        <RedTeamRunExplorer
          onOpen={(id, event) => {
            remember(event);
            onOpenRun(id);
          }}
        />
      ) : (
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
      )}

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
              writeReason,
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
          evidenceFocus.remember(event);
          setEvidenceFocusId(resultId);
          setOpenResultId(resultId);
        }}
        onEvidenceTrigger={(id, element) => {
          // Table cells may remount during query/overlay updates. Keep the
          // connected trigger, including the render that closes the sheet.
          if (element && id === evidenceFocusId) evidenceFocus.remember(element);
        }}
        remediationByResult={remediationByResult}
        returnFocusRef={returnFocusRef}
        runId={openRunId}
        writeTitle={writeTitle}
      />

      <RedTeamEvidenceSheet
        onOpenHistory={
          paged
            ? (resultId) => {
                setOpenResultId("");
                updateSearch(
                  {
                    ...Object.fromEntries(runFilterKeys.map((key) => [key, null])),
                    tab: "runs",
                    run: null,
                    runs_source_result_id: resultId,
                    runs_kind: "replay",
                  },
                  { replace: false },
                );
              }
            : undefined
        }
        onOpenRun={onOpenRun}
        canWrite={canWrite}
        onClose={() => setOpenResultId("")}
        onCreateRemediation={(resultId) => createRemediation.mutate(resultId)}
        proxyKey={proxyKey}
        resultId={openResultId}
        returnFocusRef={evidenceFocus.returnFocusRef}
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
  writeReason = writeDeniedReason,
  onApply,
  onStatus,
}: {
  canWrite: boolean;
  writeReason?: string;
  onApply: (remediation: RedTeamRemediation, event: { currentTarget: HTMLElement }) => void;
  onStatus: (remediation: RedTeamRemediation, status: string) => void;
}): ReadonlyArray<DataTableColumn<RedTeamRemediation>> {
  const column = createDataTableColumnHelper<RedTeamRemediation>();
  const writeTitle = canWrite ? undefined : writeReason;
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
