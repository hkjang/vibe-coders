import { Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { CampaignFormDialog } from "@/features/security/redteam/CampaignFormDialog";
import {
  campaignToDraft,
  emptyDraft,
  type CampaignDraft,
  type CampaignFormValues,
} from "@/features/security/redteam/campaign-draft";
import { DryRunSheet } from "@/features/security/redteam/DryRunSheet";
import { FieldRow, PanelFailure } from "@/features/security/redteam/RedTeamParts";
import { scoreTone, statusTone, writeDeniedReason } from "@/features/security/redteam/redteam-ui";
import { redteamKeys, routeId, type RedTeamData } from "@/features/security/redteam/use-redteam-data";
import { useReturnFocus } from "@/features/security/redteam/use-return-focus";
import { apiClient } from "@/shared/api/client";
import {
  withPathParams,
  type RedTeamCampaign,
  type RedTeamDryRun,
  type RedTeamRunOutcome,
} from "@/shared/api/domains/redteam";
import { endpoints } from "@/shared/api/endpoints";
import { isAppError } from "@/shared/api/error";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Sheet } from "@/shared/components/ui/Sheet";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import { DataTable } from "@/shared/data-table/DataTable";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { formatKRW, formatNumber } from "@/shared/utils/format";

const redteam = endpoints.domains.redteam;
const pollIntervalMs = 1_500;
const invalidatesAfterRun = [
  redteamKeys.runs,
  redteamKeys.campaigns,
  redteamKeys.dashboard,
  redteamKeys.baselines,
  redteamKeys.remediations,
] as const;

interface CampaignsTabProps {
  canWrite: boolean;
  data: RedTeamData;
  onOpenRunResults: (runId: string) => void;
  proxyKey: string;
}

export function RedTeamCampaignsTab({
  canWrite,
  data,
  onOpenRunResults,
  proxyKey,
}: CampaignsTabProps): React.JSX.Element {
  const { campaigns, probePacks, runs, targets } = data;
  const packs = probePacks.data?.probe_packs ?? [];
  const packIds = packs.map((pack) => pack.id);
  const campaignRows = campaigns.data?.campaigns ?? [];
  const postChange = campaigns.data?.post_change;

  const { remember, returnFocusRef } = useReturnFocus();
  const [draft, setDraft] = useState<CampaignDraft>(() => emptyDraft([]));
  const [formOpen, setFormOpen] = useState(false);
  const [dryRun, setDryRun] = useState<RedTeamDryRun | undefined>();
  const [outcome, setOutcome] = useState<RedTeamRunOutcome | undefined>();
  const [pendingDelete, setPendingDelete] = useState<RedTeamCampaign | undefined>();
  const [pendingRun, setPendingRun] = useState<RedTeamCampaign | undefined>();
  const [pendingApproval, setPendingApproval] = useState<RedTeamCampaign | undefined>();
  const [pollingCampaignId, setPollingCampaignId] = useState("");

  // Live progress: poll the run list while a campaign run is in flight, and stop
  // as soon as the run settles or the screen unmounts.
  const refetchRuns = runs.refetch;
  useEffect(() => {
    if (pollingCampaignId === "") return undefined;
    const timer = window.setInterval(() => {
      void refetchRuns();
    }, pollIntervalMs);
    return () => window.clearInterval(timer);
  }, [pollingCampaignId, refetchRuns]);

  const saveCampaign = useMutationFeedback({
    mutate: ({ values, campaignId }: { values: CampaignFormValues; campaignId: string }) => {
      const targetFilter: Record<string, unknown> = {};
      if (values.provider !== "") targetFilter.provider = values.provider;
      if (values.models.length > 0) targetFilter.models = values.models;
      return apiClient.request(redteam.campaigns.upsert, {
        body: {
          ...(campaignId === "" ? {} : { id: campaignId }),
          name: values.name,
          scope: values.scope,
          execution_mode: values.execution_mode,
          budget_limit_krw: values.budget_limit_krw,
          qps_limit: values.qps_limit,
          destructive_tool_policy: values.destructive_tool_policy,
          retain_raw_evidence: values.retain_raw_evidence,
          probe_pack_ids: values.probe_pack_ids,
          target_filter: targetFilter,
        },
        routeId,
      });
    },
    invalidates: [redteamKeys.campaigns],
    successMessage: (_result, variables) =>
      variables.campaignId === "" ? "캠페인을 생성했습니다." : "캠페인을 수정했습니다.",
    errorMessage: "캠페인을 저장하지 못했습니다.",
  });

  const deleteCampaign = useMutationFeedback({
    mutate: (campaign: RedTeamCampaign) =>
      apiClient.request(withPathParams(redteam.campaigns.remove, { id: campaign.id }), { routeId }),
    invalidates: [redteamKeys.campaigns, redteamKeys.runs, redteamKeys.dashboard],
    successMessage: "캠페인을 삭제했습니다.",
    errorMessage: "캠페인을 삭제하지 못했습니다.",
  });

  const runDryRun = useMutationFeedback({
    mutate: (campaign: RedTeamCampaign) =>
      apiClient.request(withPathParams(redteam.campaigns.dryRun, { id: campaign.id }), { routeId }),
    errorMessage: "드라이런을 실행하지 못했습니다.",
    onSuccess: (result) => setDryRun(result),
  });

  const approveCampaign = useMutationFeedback({
    mutate: (campaign: RedTeamCampaign) =>
      apiClient.request(withPathParams(redteam.campaigns.approve, { id: campaign.id }), { routeId }),
    invalidates: [redteamKeys.campaigns],
    successMessage: "캠페인을 승인했습니다.",
    errorMessage: "캠페인을 승인하지 못했습니다.",
  });

  const runCampaignRequest = useCallback(
    async (campaign: RedTeamCampaign): Promise<RedTeamRunOutcome> => {
      const live = campaign.execution_mode === "active-controlled" && proxyKey.trim() !== "";
      setPollingCampaignId(campaign.id);
      try {
        return await apiClient.request(withPathParams(redteam.campaigns.run, { id: campaign.id }), {
          body: live ? { proxy_key: proxyKey.trim() } : {},
          routeId,
          timeoutMs: 120_000,
        });
      } finally {
        setPollingCampaignId("");
      }
    },
    [proxyKey],
  );

  const runCampaign = useMutationFeedback({
    mutate: runCampaignRequest,
    invalidates: invalidatesAfterRun,
    successMessage: "캠페인 실행이 끝났습니다.",
    errorMessage: "캠페인을 실행하지 못했습니다.",
    onSuccess: (result) => setOutcome(result),
  });

  const approveThenRun = useMutationFeedback({
    mutate: async (campaign: RedTeamCampaign) => {
      await apiClient.request(withPathParams(redteam.campaigns.approve, { id: campaign.id }), {
        routeId,
      });
      return runCampaignRequest(campaign);
    },
    invalidates: invalidatesAfterRun,
    successMessage: "승인 후 캠페인을 실행했습니다.",
    errorMessage: "승인 후 실행하지 못했습니다.",
    onSuccess: (result) => setOutcome(result),
  });

  const startRun = async (campaign: RedTeamCampaign): Promise<void> => {
    try {
      await runCampaign.mutateAsync(campaign);
    } catch (error) {
      const message = isAppError(error) ? error.message : "";
      if (message.includes("requires approval")) setPendingApproval(campaign);
      throw error;
    }
  };

  const liveRuns = runs.data?.runs.filter((run) => run.campaign_id === pollingCampaignId) ?? [];
  const columns = campaignColumns({
    canWrite,
    onClone: (campaign, event) => {
      remember(event);
      setDraft(campaignToDraft(campaign, "clone", packIds));
      setFormOpen(true);
    },
    onDelete: (campaign, event) => {
      remember(event);
      setPendingDelete(campaign);
    },
    onDryRun: (campaign, event) => {
      remember(event);
      runDryRun.mutate(campaign);
    },
    onApprove: (campaign) => approveCampaign.mutate(campaign),
    onEdit: (campaign, event) => {
      remember(event);
      setDraft(campaignToDraft(campaign, "edit", packIds));
      setFormOpen(true);
    },
    onRun: (campaign, event) => {
      remember(event);
      setPendingRun(campaign);
    },
  });

  return (
    <div className="rt-stack">
      {campaigns.isError ? (
        <PanelFailure
          error={campaigns.error}
          hasData={Boolean(campaigns.data)}
          label="캠페인 목록"
          onRetry={() => void campaigns.refetch()}
        />
      ) : null}

      <SectionCard
        title="캠페인"
        description="드라이런으로 규모·비용을 확인한 뒤, (고위험 팩이면) 승인하고 실행하세요."
        actions={
          <>
            {postChange ? (
              <Badge tone={postChange.enabled ? "success" : "muted"}>
                변경 후 자동 점검: {postChange.enabled ? "켜짐" : "꺼짐"}
              </Badge>
            ) : null}
            <Button
              variant="primary"
              disabled={!canWrite || packs.length === 0}
              title={
                !canWrite
                  ? writeDeniedReason
                  : packs.length === 0
                    ? "프로브 팩이 없어 캠페인을 만들 수 없습니다."
                    : undefined
              }
              onClick={(event) => {
                remember(event);
                setDraft(emptyDraft(packIds));
                setFormOpen(true);
              }}
            >
              <Plus aria-hidden="true" /> 캠페인 만들기
            </Button>
          </>
        }
      >
        {pollingCampaignId !== "" ? (
          <div className="rt-live" role="status">
            <strong>캠페인 실행 중…</strong>
            <span>실행(run) {formatNumber(liveRuns.length)}</span>
            <span>완료 {formatNumber(liveRuns.filter((run) => run.status !== "running").length)}</span>
            <span>실패 {formatNumber(liveRuns.filter((run) => run.status === "failed").length)}</span>
            <span>
              최고 위험 {formatNumber(liveRuns.reduce((max, run) => Math.max(max, run.risk_score), 0))}
            </span>
          </div>
        ) : null}
        <DataTable
          caption="등록된 레드팀 캠페인"
          columns={columns}
          data={campaignRows}
          emptyMessage="아직 캠페인이 없습니다. '캠페인 만들기'로 범위와 프로브 팩을 골라 시작하세요."
          error={campaigns.isError && !campaigns.data ? "캠페인 목록을 불러오지 못했습니다." : undefined}
          loading={campaigns.isPending}
          onRetry={() => void campaigns.refetch()}
        />
      </SectionCard>

      <CampaignFormDialog
        draft={draft}
        onOpenChange={setFormOpen}
        onSubmit={(values, campaignId) => saveCampaign.mutateAsync({ values, campaignId })}
        open={formOpen}
        packs={packs}
        returnFocusRef={returnFocusRef}
        targets={targets.data?.targets ?? []}
      />

      <ConfirmDialog
        open={pendingDelete !== undefined}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(undefined);
        }}
        title="캠페인 삭제"
        description={`캠페인 "${pendingDelete?.name ?? ""}"과 관련 실행·결과·증적을 모두 삭제합니다. 되돌릴 수 없습니다.`}
        confirmLabel="삭제"
        tone="danger"
        returnFocusRef={returnFocusRef}
        onConfirm={() => (pendingDelete ? deleteCampaign.mutateAsync(pendingDelete) : undefined)}
      />

      <ConfirmDialog
        open={pendingRun !== undefined}
        onOpenChange={(open) => {
          if (!open) setPendingRun(undefined);
        }}
        title={pendingRun?.execution_mode === "active-controlled" ? "실제 실행(통제)" : "시뮬레이션 실행"}
        description={
          pendingRun?.execution_mode === "active-controlled"
            ? proxyKey.trim() === ""
              ? "실행 키가 없어 실제 호출 없이 시뮬레이션으로 실행합니다. 실제 호출은 상단에서 레드팀 Proxy API Key를 입력한 뒤 다시 실행하세요."
              : "입력한 레드팀 Proxy API Key로 대상 provider·model을 실제 호출합니다. 예산·QPS 한도와 킬 스위치가 적용됩니다."
            : "실제 upstream 호출 없이 시뮬레이션으로 실행합니다."
        }
        confirmLabel="실행"
        tone={
          pendingRun?.execution_mode === "active-controlled" && proxyKey.trim() !== "" ? "danger" : "primary"
        }
        returnFocusRef={returnFocusRef}
        onConfirm={() => (pendingRun ? startRun(pendingRun) : undefined)}
      />

      <ConfirmDialog
        open={pendingApproval !== undefined}
        onOpenChange={(open) => {
          if (!open) setPendingApproval(undefined);
        }}
        title="승인 후 실행"
        description="이 캠페인은 고위험 프로브 팩을 포함해 승인이 필요합니다. 지금 승인하고 실행할까요?"
        confirmLabel="승인 후 실행"
        tone="danger"
        returnFocusRef={returnFocusRef}
        onConfirm={() => (pendingApproval ? approveThenRun.mutateAsync(pendingApproval) : undefined)}
      />

      <DryRunSheet
        onOpenChange={(open) => {
          if (!open) setDryRun(undefined);
        }}
        preview={dryRun}
        returnFocusRef={returnFocusRef}
      />

      <Sheet
        open={outcome !== undefined}
        onOpenChange={(open) => {
          if (!open) setOutcome(undefined);
        }}
        title="캠페인 실행 결과"
        description="각 케이스의 요청/응답은 결과 목록의 증적에서 확인하세요."
        returnFocusRef={returnFocusRef}
        size="wide"
      >
        {outcome ? (
          <div className="rt-stack">
            <KeyValueList
              items={[
                { label: "실행 수", value: formatNumber(outcome.summary.runs) },
                { label: "케이스 결과", value: formatNumber(outcome.summary.results) },
                { label: "치명", value: formatNumber(outcome.summary.critical) },
                { label: "실패", value: formatNumber(outcome.summary.failures) },
                { label: "경고", value: formatNumber(outcome.summary.warnings) },
                {
                  label: "실제 upstream 호출",
                  value:
                    outcome.summary.live_calls > 0 ? (
                      <Badge tone="danger">
                        예 — {formatNumber(outcome.summary.live_calls)}건 실제 호출됨
                      </Badge>
                    ) : (
                      <Badge tone="success">아니오 — 시뮬레이션</Badge>
                    ),
                },
                { label: "실행 모드", value: outcome.summary.mode },
                {
                  label: "상태",
                  value: (
                    <span>
                      <Badge tone={statusTone(outcome.status)}>{outcome.status}</Badge>
                      {outcome.stopped !== "" ? (
                        <Badge tone="warning">{outcome.stopped} 사유로 중단</Badge>
                      ) : null}
                    </span>
                  ),
                },
              ]}
            />
            <p className="rt-note">{outcome.note}</p>
            {outcome.runs.length > 0 ? (
              <FieldRow label="실행별 결과 바로 보기">
                <div className="rt-button-row">
                  {outcome.runs.map((run) => (
                    <Button
                      key={run.id}
                      size="small"
                      onClick={() => {
                        setOutcome(undefined);
                        onOpenRunResults(run.id);
                      }}
                    >
                      {run.target_id || run.id}{" "}
                      <Badge tone={scoreTone(run.risk_score)}>{formatNumber(run.risk_score)}</Badge>
                    </Button>
                  ))}
                </div>
              </FieldRow>
            ) : null}
          </div>
        ) : null}
      </Sheet>
    </div>
  );
}

interface CampaignActionHandlers {
  canWrite: boolean;
  onApprove: (campaign: RedTeamCampaign) => void;
  onClone: (campaign: RedTeamCampaign, event: { currentTarget: HTMLElement }) => void;
  onDelete: (campaign: RedTeamCampaign, event: { currentTarget: HTMLElement }) => void;
  onDryRun: (campaign: RedTeamCampaign, event: { currentTarget: HTMLElement }) => void;
  onEdit: (campaign: RedTeamCampaign, event: { currentTarget: HTMLElement }) => void;
  onRun: (campaign: RedTeamCampaign, event: { currentTarget: HTMLElement }) => void;
}

function campaignColumns(handlers: CampaignActionHandlers): ReadonlyArray<DataTableColumn<RedTeamCampaign>> {
  const column = createDataTableColumnHelper<RedTeamCampaign>();
  const writeTitle = handlers.canWrite ? undefined : writeDeniedReason;
  return column.columns([
    column.accessor((row) => row.name, {
      id: "name",
      header: "이름",
      cell: ({ row }) => (
        <div className="rt-stacked-cell">
          <strong>{row.original.name}</strong>
          <code className="mono">{row.original.id}</code>
        </div>
      ),
    }),
    column.accessor((row) => row.trigger_source, {
      id: "trigger",
      header: "생성 경로",
      cell: ({ row }) =>
        row.original.trigger_source === "post-change" ? (
          <div className="rt-stacked-cell">
            <Badge tone="info">변경 후 자동</Badge>
            <span title={row.original.trigger_reason || undefined}>{row.original.trigger_action || "—"}</span>
          </div>
        ) : (
          <span className="rt-muted">수동</span>
        ),
    }),
    column.accessor((row) => row.scope, { id: "scope", header: "범위" }),
    column.accessor((row) => row.status, {
      id: "status",
      header: "상태",
      cell: ({ getValue }) => <Badge tone={statusTone(getValue())}>{getValue() || "—"}</Badge>,
    }),
    column.accessor((row) => row.execution_mode, { id: "mode", header: "모드" }),
    column.accessor((row) => row.budget_limit_krw, {
      id: "budget",
      header: "예산",
      cell: ({ getValue }) => <span className="cell-number">{formatKRW(getValue())}</span>,
    }),
    column.accessor((row) => row.retain_raw_evidence, {
      id: "evidence",
      header: "증적",
      cell: ({ getValue }) =>
        getValue() ? <Badge tone="warning">원문보관</Badge> : <span className="rt-muted">마스킹</span>,
    }),
    column.display({
      id: "actions",
      header: "작업",
      cell: ({ row }) => {
        const campaign = row.original;
        const automatic = campaign.trigger_source === "post-change";
        return (
          <div className="table-actions">
            <Button
              size="small"
              disabled={!handlers.canWrite}
              title={writeTitle}
              aria-label={`${campaign.name} 드라이런`}
              onClick={(event) => handlers.onDryRun(campaign, event)}
            >
              드라이런
            </Button>
            {automatic ? null : (
              <Button
                size="small"
                disabled={!handlers.canWrite}
                title={writeTitle}
                aria-label={`${campaign.name} 승인`}
                onClick={() => handlers.onApprove(campaign)}
              >
                승인
              </Button>
            )}
            <Button
              size="small"
              variant="primary"
              disabled={!handlers.canWrite}
              title={writeTitle}
              aria-label={`${campaign.name} ${campaign.execution_mode === "active-controlled" ? "실제 실행" : "시뮬레이션 실행"}`}
              onClick={(event) => handlers.onRun(campaign, event)}
            >
              {campaign.execution_mode === "active-controlled" ? "실제 실행" : "시뮬레이션 실행"}
            </Button>
            {automatic ? null : (
              <Button
                size="small"
                disabled={!handlers.canWrite}
                title={writeTitle}
                aria-label={`${campaign.name} 수정`}
                onClick={(event) => handlers.onEdit(campaign, event)}
              >
                수정
              </Button>
            )}
            <Button
              size="small"
              disabled={!handlers.canWrite}
              title={writeTitle}
              aria-label={`${campaign.name} 복제`}
              onClick={(event) => handlers.onClone(campaign, event)}
            >
              복제
            </Button>
            <Button
              size="small"
              variant="danger"
              disabled={!handlers.canWrite}
              title={writeTitle}
              aria-label={`${campaign.name} 삭제`}
              onClick={(event) => handlers.onDelete(campaign, event)}
            >
              삭제
            </Button>
          </div>
        );
      },
    }),
  ]);
}
