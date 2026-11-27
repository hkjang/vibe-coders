import { useQueryClient } from "@tanstack/react-query";
import { Download, RefreshCw } from "lucide-react";
import { useState } from "react";

import { useAuth } from "@/app/auth/AuthProvider";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { PageHeader } from "@/shared/components/page/PageHeader";
import { TabPanel, Tabs } from "@/shared/components/ui/Tabs";
import { useFeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";
import { useFileDownload } from "@/shared/hooks/use-file-download";
import { useReturnFocus } from "@/shared/hooks/use-return-focus";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { useTabParam } from "@/shared/hooks/use-tab-param";
import { containsPotentialSecret } from "@/shared/security/secrets";

import "@/features/insights/charts/charts.css";
import "./usage.css";

import { categoryNames } from "./drill-path";
import { readListState } from "./session-list-model";
import { SessionDetailSheet } from "./SessionDetailSheet";
import { CategoriesTab } from "./tabs/CategoriesTab";
import { ModelsTab } from "./tabs/ModelsTab";
import { ProductivityTab } from "./tabs/ProductivityTab";
import { SessionsTab } from "./tabs/SessionsTab";
import { SummaryTab } from "./tabs/SummaryTab";
import { TeamsTab } from "./tabs/TeamsTab";
import { TrendsTab } from "./tabs/TrendsTab";
import { usageFeatureId, usageKey, useCategories, useOverview, useUsageStatus } from "./use-usage-queries";
import { isAnalyticsDisabled, isUnavailable } from "./usage-errors";
import { downloadUsageCsv, exportQuery, exportView, exportViewLabels } from "./usage-export";
import {
  filtersQuery,
  optionsQuery,
  periodRange,
  readUsageFilters,
  safeCategoryId,
  safeText,
  seoulToday,
  usageTabLabels,
  usageTabs,
  type UsageTab,
} from "./usage-filters";
import { UsageFilterBar } from "./UsageFilterBar";
import { UsageReadContext } from "./usage-read-context";
import { AnalysisUnavailable, ScopeLine, ScopeNotices } from "./UsageScope";
import type { UsageTabProps } from "./usage-tab-props";

const panelPrefix = "work-usage";

/** 업무 활용 분석: what work AI is used for, by category, team and model. */
export function UsagePage(): React.JSX.Element {
  const owner = useFeatureReadOwner(usageFeatureId, "work-usage");
  return (
    <UsageReadContext value={owner}>
      <UsageScreen />
    </UsageReadContext>
  );
}

function UsageScreen(): React.JSX.Element {
  const queryClient = useQueryClient();
  const { credentialPrefixes } = useAuth();
  const [params, update] = useSearchState();
  const [tab, setTab] = useTabParam<UsageTab>(usageTabs);
  const { returnFocusRef, rememberActive } = useReturnFocus();
  // The Seoul calendar day the presets end on. Fixed while the screen is open so a
  // query key does not change at midnight under the reader; "새로고침" moves it on.
  const [today, setToday] = useState(() => seoulToday());

  const filters = readUsageFilters(params);
  const range = periodRange(filters.period, today);
  const query = filtersQuery(filters, today);
  const list = readListState(params);
  const parent = safeCategoryId(params.get("parent"));
  // The open session is in the URL, so it can be linked and Back closes it. The URL
  // policy refuses values that look like credentials; such an ID is kept here instead.
  const [unlinkedSession, setUnlinkedSession] = useState("");
  const sessionId = safeText(params.get("session"), 200) || unlinkedSession;

  // The worker status is read first: it says whether the analysis exists and is on,
  // so a server without it answers one request instead of failing a dozen panels.
  const status = useUsageStatus();
  const statusUnavailable = status.isError && isUnavailable(status.error);
  const settled = !status.isPending;
  const overview = useOverview(
    query,
    settled && !statusUnavailable && status.data?.analytics_enabled !== false,
  );
  const disabled =
    status.data?.analytics_enabled === false ||
    isAnalyticsDisabled(status.error) ||
    isAnalyticsDisabled(overview.error);
  const blocked = statusUnavailable || disabled;
  const live = settled && !blocked;
  const scope = overview.data?.scope;
  const minGroupSize = scope?.min_group_size ?? 3;

  // The same read the filter bar uses for its 대분류 list; it names the category in the scope line.
  const topCategories = useCategories(optionsQuery(range), "", live);
  const names = categoryNames(topCategories.data?.rows.map((row) => row.category));

  const view = exportView(tab, list.kind);
  const csvQuery = view
    ? exportQuery(query, view, { parent: tab === "categories" ? parent : "", status: list.status })
    : undefined;
  const csv = useFileDownload(
    usageFeatureId,
    JSON.stringify(csvQuery ?? null),
    live && csvQuery !== undefined,
  );
  const exportCsv = (): void => {
    if (!csvQuery) return;
    void csv.run((ownership) => downloadUsageCsv(csvQuery, ownership), {
      errorMessage: "CSV를 내보내지 못했습니다.",
      toastErrors: false,
    });
  };

  const refresh = (): void => {
    setToday(seoulToday());
    void queryClient.invalidateQueries({ queryKey: [...usageKey] });
  };
  const openSession = (id: string): void => {
    rememberActive();
    if (containsPotentialSecret(id, credentialPrefixes)) setUnlinkedSession(id);
    else update({ session: id }, { replace: false });
  };
  const closeSession = (): void => {
    setUnlinkedSession("");
    update({ session: undefined });
  };

  const tabProps: UsageTabProps = { filters, query, range, minGroupSize };

  return (
    <div className="page-stack wi-viz wi-usage">
      <PageHeader
        title="업무 활용 분석"
        description="AI가 어떤 업무에 쓰이는지 업무 유형·조직·모델별로 봅니다. 요청을 업무로 분류한 집계이며 프롬프트 원문은 표시하지 않습니다."
        actions={
          <>
            <Button
              variant="secondary"
              onClick={exportCsv}
              disabled={csv.pending || !csv.available || !view}
              title={
                view
                  ? `${exportViewLabels[view]} 표를 현재 필터로 내보냅니다.`
                  : "이 탭에는 내보낼 표가 없습니다. 업무 유형·조직·모델·세션·요청 탭에서 내보낼 수 있습니다."
              }
            >
              <Download aria-hidden="true" /> {csv.pending ? "내보내는 중" : "CSV 내보내기"}
            </Button>
            <Button variant="primary" onClick={refresh}>
              <RefreshCw aria-hidden="true" /> 새로고침
            </Button>
          </>
        }
      />

      <UsageFilterBar filters={filters} today={today} scope={scope} enabled={live} update={update} />
      <ScopeLine
        filters={filters}
        today={today}
        scope={scope}
        categoryName={names.get(filters.category) ?? ""}
      />

      {csv.error ? (
        <InlineNotice tone="danger" title="CSV 내보내기 실패">
          {csv.error.message}
          {csv.error.requestId ? ` 요청 ID: ${csv.error.requestId}` : ""}
        </InlineNotice>
      ) : null}

      {blocked ? (
        <AnalysisUnavailable disabled={disabled} />
      ) : !settled ? (
        <div className="wi-panel-skeleton" role="status">
          <span className="skeleton skeleton-title" />
          <span className="skeleton skeleton-line" />
          <span className="sr-only">업무 활용 분석 상태를 확인하는 중입니다.</span>
        </div>
      ) : (
        <>
          <ScopeNotices
            scope={scope}
            status={status.data}
            statusFailed={status.isError && !statusUnavailable && !disabled}
          />
          <Tabs
            ariaLabel="업무 활용 분석 화면"
            items={usageTabs.map((id) => ({ id, label: usageTabLabels[id] }))}
            onChange={setTab}
            panelIdPrefix={panelPrefix}
            value={tab}
          />
          <TabPanel id={tab} panelIdPrefix={panelPrefix}>
            {tab === "summary" ? <SummaryTab {...tabProps} overview={overview} /> : null}
            {tab === "categories" ? <CategoriesTab {...tabProps} /> : null}
            {tab === "teams" ? <TeamsTab {...tabProps} /> : null}
            {tab === "models" ? <ModelsTab {...tabProps} /> : null}
            {tab === "trends" ? <TrendsTab {...tabProps} /> : null}
            {tab === "sessions" ? <SessionsTab {...tabProps} onOpenSession={openSession} /> : null}
            {tab === "productivity" ? <ProductivityTab {...tabProps} /> : null}
          </TabPanel>
          {sessionId ? (
            <SessionDetailSheet
              key={sessionId}
              sessionId={sessionId}
              returnFocusRef={returnFocusRef}
              onClose={closeSession}
            />
          ) : null}
        </>
      )}
    </div>
  );
}
