import { useQueryClient } from "@tanstack/react-query";
import { KeyRound, RefreshCw, Zap } from "lucide-react";
import { useState } from "react";

import { useAuth } from "@/app/auth/AuthProvider";
import { RedTeamEmergencyPanel } from "./RedTeamEmergencyPanel";
import { readPreflight } from "./read-preflight";
import { DryRunSheet } from "@/features/security/redteam/DryRunSheet";
import { RedTeamCampaignsTab } from "@/features/security/redteam/RedTeamCampaignsTab";
import { RedTeamOverviewTab } from "@/features/security/redteam/RedTeamOverviewTab";
import { RedTeamRunsTab } from "@/features/security/redteam/RedTeamRunsTab";
import { RedTeamSchedulesTab } from "@/features/security/redteam/RedTeamSchedulesTab";
import { RedTeamTargetsTab } from "@/features/security/redteam/RedTeamTargetsTab";
import { writeDeniedReason } from "@/features/security/redteam/redteam-ui";
import { redteamKeys, routeId, useRedTeamData } from "@/features/security/redteam/use-redteam-data";
import { useReturnFocus } from "@/shared/hooks/use-return-focus";
import { apiClient } from "@/shared/api/client";
import { type RedTeamDryRun } from "@/shared/api/domains/redteam";
import { endpoints } from "@/shared/api/endpoints";
import { isAppError } from "@/shared/api/error";
import { PageHeader } from "@/shared/components/page/PageHeader";
import { Button } from "@/shared/components/ui/Button";
import { Input } from "@/shared/components/ui/Input";
import { TabPanel, Tabs, type TabItem } from "@/shared/components/ui/Tabs";
import { ErrorState, LoadingState } from "@/shared/components/state/PageStates";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { useTabParam } from "@/shared/hooks/use-tab-param";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import "@/features/security/redteam/redteam.css";

const redteam = endpoints.domains.redteam;

const tabIds = ["overview", "campaigns", "targets", "runs", "schedules"] as const;
type RedTeamTabId = (typeof tabIds)[number];

const tabItems: ReadonlyArray<TabItem<RedTeamTabId>> = [
  { id: "overview", label: "개요·지표" },
  { id: "campaigns", label: "캠페인" },
  { id: "targets", label: "대상·검사 묶음" },
  { id: "runs", label: "실행·조치" },
  { id: "schedules", label: "일정" },
];

export function RedTeamPage(): React.JSX.Element {
  const auth = useAuth();
  const client = useQueryClient();
  const canWrite = auth.user?.scopes.includes("admin:write") ?? false;
  const data = useRedTeamData();
  const [tab, setTab] = useTabParam<RedTeamTabId>([...tabIds]);
  // The red-team Proxy API Key stays in memory for this session only: it is never
  // written to storage, the URL, logs or toasts.
  const [proxyKey, setProxyKey] = useState("");
  const [quickStart, setQuickStart] = useState<RedTeamDryRun | undefined>();
  const [openRunId, setOpenRunId] = useState("");
  const { remember, returnFocusRef } = useReturnFocus();

  const queries = Object.values(data);
  const allPending = queries.every((query) => query.isPending);
  const allFailed = queries.every((query) => query.isError);
  const firstError = queries.find((query) => query.isError)?.error;

  const runQuickStart = useMutationFeedback({
    mutate: async () => {
      const packs = (data.probePacks.data?.probe_packs ?? []).filter((pack) => !pack.requires_approval);
      if (packs.length === 0) {
        throw new Error("승인 불필요한 안전 검사 묶음이 없습니다. 캠페인 빌더에서 직접 구성하세요.");
      }
      const created = await apiClient.request(redteam.campaigns.upsert, {
        body: {
          name: "빠른시작 드라이런",
          scope: "all",
          execution_mode: "dry-run",
          budget_limit_krw: 1_000,
          qps_limit: 1,
          destructive_tool_policy: "dry-run",
          retain_raw_evidence: false,
          probe_pack_ids: packs.map((pack) => pack.id),
          target_filter: {},
        },
        routeId,
      });
      return readPreflight(created.campaign.id);
    },
    invalidates: [redteamKeys.campaigns],
    errorMessage: "빠른 시작을 실행하지 못했습니다.",
    onSuccess: (result) => setQuickStart(result),
  });

  const refreshAll = (): void => {
    void client.invalidateQueries({ queryKey: redteamKeys.killSwitch });
    for (const query of queries) void query.refetch();
  };
  const refreshing = queries.some((query) => query.isFetching);

  const openRunResults = (runId: string): void => {
    setOpenRunId(runId);
    if (runId !== "") setTab("runs");
  };

  if (allPending) {
    return (
      <div className="page-stack">
        <PageHeader
          title="레드팀 자동화"
          status="preview"
          legacyHref="/admin#/redteam"
          description="게이트웨이에 등록된 연결만 대상으로 하는 허가형 AI 보안 회귀 테스트입니다."
        />
        <RedTeamEmergencyPanel canWrite={canWrite} />
        <LoadingState label="레드팀 데이터를 불러오는 중입니다." />
      </div>
    );
  }

  if (allFailed) {
    return (
      <div className="page-stack">
        <PageHeader
          title="레드팀 자동화"
          description="보안 회귀 테스트와 긴급 제어 상태를 확인합니다."
          legacyHref="/admin#/redteam"
        />
        <RedTeamEmergencyPanel canWrite={canWrite} />
        <ErrorState
          message={safeAppErrorMessage(firstError, "레드팀 데이터를 불러오지 못했습니다.")}
          requestId={isAppError(firstError) ? firstError.requestId : undefined}
          onRetry={refreshAll}
          legacyHref="/admin#/redteam"
        />
      </div>
    );
  }

  return (
    <div className="page-stack">
      <PageHeader
        title="레드팀 자동화"
        status="preview"
        legacyHref="/admin#/redteam"
        description="게이트웨이에 등록된 연결만 대상으로 하는 허가형 AI 보안 회귀 테스트입니다. 기본은 드라이런이며, 고위험 묶음은 승인 없이 실제 실행되지 않습니다."
        actions={
          <>
            <Button
              disabled={!canWrite || runQuickStart.isPending}
              title={canWrite ? undefined : writeDeniedReason}
              onClick={(event) => {
                remember(event);
                runQuickStart.mutate(undefined);
              }}
            >
              <Zap aria-hidden="true" /> 빠른 시작(안전 묶음 드라이런)
            </Button>
            <Button variant="primary" onClick={refreshAll} disabled={refreshing}>
              <RefreshCw aria-hidden="true" /> {refreshing ? "갱신 중" : "새로고침"}
            </Button>
          </>
        }
      />

      <RedTeamEmergencyPanel canWrite={canWrite} />

      <section className="rt-safety" aria-label="레드팀 안전장치">
        <form className="rt-key-form" onSubmit={(event) => event.preventDefault()}>
          <label htmlFor="rt-proxy-key">
            <KeyRound aria-hidden="true" /> 레드팀 실행 키
          </label>
          <Input
            id="rt-proxy-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={proxyKey}
            placeholder="실제 실행에만 사용 · 저장하지 않음"
            aria-describedby="rt-proxy-key-help"
            onChange={(event) => setProxyKey(event.target.value)}
          />
          <Button size="small" disabled={proxyKey === ""} onClick={() => setProxyKey("")}>
            키 지우기
          </Button>
          <p id="rt-proxy-key-help" className="rt-muted">
            이 키는 이 세션 메모리에만 남고 브라우저 저장소·주소·로그에 기록되지 않습니다. 비우면 실제 호출
            없이 시뮬레이션으로 실행됩니다.
          </p>
        </form>
      </section>

      <Tabs ariaLabel="레드팀 화면" items={tabItems} onChange={setTab} panelIdPrefix="redteam" value={tab} />

      {tab === "overview" ? (
        <TabPanel id="overview" panelIdPrefix="redteam">
          <RedTeamOverviewTab data={data} />
        </TabPanel>
      ) : null}
      {tab === "campaigns" ? (
        <TabPanel id="campaigns" panelIdPrefix="redteam">
          <RedTeamCampaignsTab
            canWrite={canWrite}
            data={data}
            onOpenRunResults={openRunResults}
            proxyKey={proxyKey}
          />
        </TabPanel>
      ) : null}
      {tab === "targets" ? (
        <TabPanel id="targets" panelIdPrefix="redteam">
          <RedTeamTargetsTab canWrite={canWrite} data={data} />
        </TabPanel>
      ) : null}
      {tab === "runs" ? (
        <TabPanel id="runs" panelIdPrefix="redteam">
          <RedTeamRunsTab
            canWrite={canWrite}
            data={data}
            onOpenRun={setOpenRunId}
            openRunId={openRunId}
            proxyKey={proxyKey}
          />
        </TabPanel>
      ) : null}
      {tab === "schedules" ? (
        <TabPanel id="schedules" panelIdPrefix="redteam">
          <RedTeamSchedulesTab canWrite={canWrite} data={data} />
        </TabPanel>
      ) : null}

      <DryRunSheet
        onOpenChange={(open) => {
          if (!open) setQuickStart(undefined);
        }}
        preview={quickStart}
        returnFocusRef={returnFocusRef}
      />
    </div>
  );
}
