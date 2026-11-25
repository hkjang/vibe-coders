import { useRedTeamMutation } from "./use-redteam-mutation";
import { campaignColumns } from "./campaign-columns";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/app/auth/AuthProvider";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { reviewHistoryLink } from "./review-history-link";
import { tokenStore } from "@/shared/auth/token-store";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { RedTeamJobPanel } from "./RedTeamJobPanel";
import { readRedTeamJobRef, redTeamJobKey } from "@/shared/utils/redteam-job-query";
import { Plus } from "lucide-react";
import { lazy, Suspense, useContext, useEffect, useState, useSyncExternalStore } from "react";

import { CampaignFormDialog } from "@/features/security/redteam/CampaignFormDialog";
import {
  campaignToDraft,
  emptyDraft,
  type CampaignDraft,
  type CampaignFormValues,
} from "@/features/security/redteam/campaign-draft";
import { usePreflightReturnFocus } from "./use-preflight-return-focus";
import { readPreflight } from "./read-preflight";
import { DryRunSheet } from "@/features/security/redteam/DryRunSheet";
import { PanelFailure } from "@/features/security/redteam/RedTeamParts";
import { writeDeniedReason } from "@/features/security/redteam/redteam-ui";
import { redteamKeys, routeId, type RedTeamData } from "@/features/security/redteam/use-redteam-data";
import { useReturnFocus } from "@/shared/hooks/use-return-focus";
import { apiClient } from "@/shared/api/client";
import {
  withPathParams,
  type RedTeamCampaign,
  type RedTeamDryRun,
  type RedTeamRunOutcome,
} from "@/shared/api/domains/redteam";
import { endpoints } from "@/shared/api/endpoints";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { RedTeamRunOutcomeSheet } from "./RedTeamRunOutcomeSheet";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { DataTable } from "@/shared/data-table/DataTable";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { formatNumber } from "@/shared/utils/format";

const redteam = endpoints.domains.redteam;
const RedTeamReviewedExecution = lazy(() =>
  import("./RedTeamReviewedExecution").then((module) => ({ default: module.RedTeamReviewedExecution })),
);
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
  writeReason?: string;
  data: RedTeamData;
  onOpenRunResults: (runId: string) => void;
  proxyKey: string;
}

export function RedTeamCampaignsTab(props: CampaignsTabProps): React.JSX.Element {
  const auth = useAuth();
  const context = useContext(FeatureAccessContext);
  const epoch = useSyncExternalStore(tokenStore.subscribeSession, tokenStore.getSessionEpoch);
  const owner = JSON.stringify([
    epoch,
    auth.mode,
    auth.user?.id,
    auth.user?.role,
    auth.user?.roles,
    auth.user?.team_id,
    auth.user?.scopes,
    props.canWrite,
    context?.featureId,
    context?.permitted,
    context?.readOnly,
  ]);
  return <CampaignsTab key={owner} {...props} />;
}
function CampaignsTab({
  canWrite,
  writeReason = writeDeniedReason,
  data,
  onOpenRunResults,
  proxyKey,
}: CampaignsTabProps): React.JSX.Element {
  const client = useQueryClient();
  const { backendVersion, credentialPrefixes } = useAuth();
  const [params, updateSearch] = useSearchState();
  const executionJob = readRedTeamJobRef(params, credentialPrefixes);
  const { campaigns, probePacks, runs, targets } = data;
  const packs = probePacks.data?.probe_packs ?? [];
  const packIds = packs.map((pack) => pack.id);
  const campaignRows = campaigns.data?.campaigns ?? [];
  const postChange = campaigns.data?.post_change;

  const { remember, returnFocusRef } = useReturnFocus();
  const preflightFocus = usePreflightReturnFocus(returnFocusRef);
  const runFocus = usePreflightReturnFocus(returnFocusRef);
  const [draft, setDraft] = useState<CampaignDraft>(() => emptyDraft([]));
  const [formOpen, setFormOpen] = useState(false);
  const [dryRun, setDryRun] = useState<RedTeamDryRun | undefined>();
  const [outcome, setOutcome] = useState<RedTeamRunOutcome | undefined>();
  const [pendingDelete, setPendingDelete] = useState<RedTeamCampaign | undefined>();
  const [pendingRun, setPendingRun] = useState<RedTeamCampaign | undefined>();
  const [pollingCampaignId, setPollingCampaignId] = useState("");

  // Live progress: poll the run list while a campaign run is in flight, and stop
  // as soon as the run settles or the screen unmounts.
  const refetchRuns = runs.refetch;
  useEffect(() => {
    if (pollingCampaignId === "") return undefined;
    const timer = window.setInterval(() => {
      if (!document.hidden) void refetchRuns();
    }, pollIntervalMs);
    return () => window.clearInterval(timer);
  }, [pollingCampaignId, refetchRuns]);

  const saveCampaign = useRedTeamMutation(canWrite, {
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
          external_provider_allowed: values.external_provider_allowed,
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

  const deleteCampaign = useRedTeamMutation(canWrite, {
    mutate: (campaign: RedTeamCampaign) =>
      apiClient.request(withPathParams(redteam.campaigns.remove, { id: campaign.id }), { routeId }),
    invalidates: [redteamKeys.campaigns, redteamKeys.runs, redteamKeys.dashboard],
    successMessage: "캠페인을 삭제했습니다.",
    errorMessage: "캠페인을 삭제하지 못했습니다.",
  });

  const runDryRun = useMutationFeedback({
    mutate: (campaign: RedTeamCampaign) => readPreflight(campaign.id),
    errorMessage: "사전 점검 결과를 확인하지 못했습니다.",
    onSuccess: (result) => setDryRun(result),
  });

  const approveCampaign = useRedTeamMutation(canWrite, {
    mutate: (campaign: RedTeamCampaign) =>
      apiClient.request(withPathParams(redteam.campaigns.approve, { id: campaign.id }), { routeId }),
    invalidates: [redteamKeys.campaigns],
    successMessage: "캠페인을 승인했습니다.",
    errorMessage: "캠페인을 승인하지 못했습니다.",
  });

  const liveRuns = runs.data?.runs.filter((run) => run.campaign_id === pollingCampaignId) ?? [];
  const columns = campaignColumns({
    canWrite,
    writeReason,
    checking: runDryRun.isPending,
    preflightTriggerRef: preflightFocus.register,
    runTriggerRef: runFocus.register,
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
      preflightFocus.remember(campaign.id);
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
      runFocus.remember(campaign.id);
      remember(event);
      setPendingRun(campaign);
    },
  });

  return (
    <div className="rt-stack">
      {executionJob ? (
        <RedTeamJobPanel
          job={executionJob}
          onOutcome={setOutcome}
          onClose={() => updateSearch({ execution_job: undefined, job_campaign: undefined })}
        />
      ) : null}
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
        description="사전 점검으로 대상·예상 비용·승인 조건을 확인한 뒤 실행하세요."
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
                  ? writeReason
                  : packs.length === 0
                    ? "검사 묶음이 없어 캠페인을 만들 수 없습니다."
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
          emptyMessage="아직 캠페인이 없습니다. '캠페인 만들기'로 범위와 검사 묶음을 골라 시작하세요."
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

      {pendingRun ? (
        <Suspense fallback={<p role="status">실행 검토 화면을 불러오고 있습니다.</p>}>
          <RedTeamReviewedExecution
            campaign={pendingRun}
            proxyKey={proxyKey}
            canWrite={canWrite}
            historyAvailable={(reviewId) =>
              Boolean(reviewHistoryLink(backendVersion, pendingRun.id, reviewId, credentialPrefixes))
            }
            onOpenHistory={(reviewId) => {
              const link = reviewHistoryLink(backendVersion, pendingRun.id, reviewId, credentialPrefixes);
              if (link) updateSearch(link, { replace: false });
            }}
            onClose={() => {
              setPendingRun(undefined);
              setPollingCampaignId("");
            }}
            onPending={(pending) => setPollingCampaignId(pending ? pendingRun.id : "")}
            onJobTracked={(job) =>
              updateSearch({ tab: "campaigns", execution_job: job.id, job_campaign: job.campaign })
            }
            onJobAccepted={(job) => {
              setPendingRun(undefined);
              setPollingCampaignId("");
              void client.invalidateQueries({ queryKey: redTeamJobKey(job) });
            }}
            onResult={(result) => {
              setPendingRun(undefined);
              setPollingCampaignId("");
              setOutcome(result);
              for (const key of invalidatesAfterRun) void client.invalidateQueries({ queryKey: key });
            }}
            returnFocusRef={runFocus.returnFocusRef}
          />
        </Suspense>
      ) : null}

      <DryRunSheet
        onOpenChange={(open) => {
          if (!open) setDryRun(undefined);
        }}
        preview={dryRun}
        returnFocusRef={preflightFocus.returnFocusRef}
      />

      <RedTeamRunOutcomeSheet
        outcome={outcome}
        onClose={() => setOutcome(undefined)}
        onOpenRun={onOpenRunResults}
        returnFocusRef={runFocus.returnFocusRef}
      />
    </div>
  );
}
