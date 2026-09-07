import { useState } from "react";

import { PanelFailure } from "@/features/security/redteam/RedTeamParts";
import { cronPresets, writeDeniedReason } from "@/features/security/redteam/redteam-ui";
import { redteamKeys, routeId, type RedTeamData } from "@/features/security/redteam/use-redteam-data";
import { apiClient } from "@/shared/api/client";
import type { RedTeamSchedule } from "@/shared/api/domains/redteam";
import { endpoints } from "@/shared/api/endpoints";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import { DataTable } from "@/shared/data-table/DataTable";
import { FormField } from "@/shared/components/form/FormField";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { formatNumber, formatRelative } from "@/shared/utils/format";

const redteam = endpoints.domains.redteam;

export function RedTeamSchedulesTab({
  canWrite,
  data,
}: {
  canWrite: boolean;
  data: RedTeamData;
}): React.JSX.Element {
  const { campaigns, schedules } = data;
  const campaignRows = campaigns.data?.campaigns ?? [];
  const scheduleRows = schedules.data?.schedules ?? [];
  const [campaignId, setCampaignId] = useState("");
  const [cron, setCron] = useState<string>(cronPresets[0].value);
  const selectedCampaign = campaignId || campaignRows[0]?.id || "";
  const writeTitle = canWrite ? undefined : writeDeniedReason;

  const upsert = useMutationFeedback({
    mutate: (schedule: {
      id?: string;
      campaign_template_id: string;
      cron_expr: string;
      timezone?: string;
      enabled: boolean;
    }) => apiClient.request(redteam.schedules.upsert, { body: schedule, routeId }),
    invalidates: [redteamKeys.schedules],
    successMessage: "일정을 저장했습니다.",
    errorMessage: "일정을 저장하지 못했습니다.",
  });

  const campaignNames = new Map(campaignRows.map((campaign) => [campaign.id, campaign.name]));

  return (
    <div className="rt-stack">
      <InlineNotice tone="info" title="예약 실행은 항상 시뮬레이션입니다.">
        활성 일정은 백그라운드 스케줄러가 주기적으로 실행합니다. 스케줄 실행은 전용 키가 없어 실제 호출을 하지
        않습니다. 실제 호출이 필요하면 캠페인 탭에서 수동 실행하세요. 킬 스위치가 켜져 있으면 예약 실행도
        중지됩니다.
      </InlineNotice>

      {schedules.isError ? (
        <PanelFailure
          error={schedules.error}
          hasData={Boolean(schedules.data)}
          label="일정"
          onRetry={() => void schedules.refetch()}
        />
      ) : null}

      <SectionCard title="일정 예약" description="실행할 캠페인과 주기를 고르세요.">
        <form
          className="rt-schedule-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (selectedCampaign === "") return;
            upsert.mutate({
              campaign_template_id: selectedCampaign,
              cron_expr: cron,
              enabled: true,
            });
          }}
        >
          <FormField label="캠페인" description="실행할 캠페인 템플릿" id="rt-schedule-campaign">
            {(control) => (
              <Select
                {...control}
                value={selectedCampaign}
                disabled={campaignRows.length === 0}
                onChange={(event) => setCampaignId(event.target.value)}
              >
                {campaignRows.length === 0 ? (
                  <option value="">(캠페인 없음 — 먼저 캠페인을 만드세요)</option>
                ) : null}
                {campaignRows.map((campaign) => (
                  <option key={campaign.id} value={campaign.id}>
                    {campaign.name}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
          <FormField
            label="주기(cron)"
            description="@hourly · @daily · @weekly · every:<n>m/h"
            id="rt-schedule-cron"
          >
            {(control) => (
              <Select {...control} value={cron} onChange={(event) => setCron(event.target.value)}>
                {cronPresets.map((preset) => (
                  <option key={preset.value} value={preset.value}>
                    {preset.label}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
          <Button
            type="submit"
            variant="primary"
            disabled={!canWrite || campaignRows.length === 0 || upsert.isPending}
            title={
              !canWrite
                ? writeTitle
                : campaignRows.length === 0
                  ? "먼저 캠페인을 만든 뒤 일정을 추가하세요."
                  : undefined
            }
          >
            일정 추가
          </Button>
        </form>
      </SectionCard>

      <SectionCard title={`등록된 일정 (${formatNumber(scheduleRows.length)})`}>
        <DataTable
          caption="등록된 레드팀 실행 일정"
          columns={scheduleColumns({
            campaignNames,
            canWrite,
            onToggle: (schedule) =>
              upsert.mutate({
                id: schedule.id,
                campaign_template_id: schedule.campaign_template_id,
                cron_expr: schedule.cron_expr,
                timezone: schedule.timezone,
                enabled: !schedule.enabled,
              }),
          })}
          data={scheduleRows}
          emptyMessage="등록된 일정이 없습니다. 위에서 캠페인과 주기를 선택해 추가하세요."
          error={schedules.isError && !schedules.data ? "일정을 불러오지 못했습니다." : undefined}
          loading={schedules.isPending}
          onRetry={() => void schedules.refetch()}
        />
        {schedules.data?.note ? <p className="rt-note">{schedules.data.note}</p> : null}
      </SectionCard>
    </div>
  );
}

function scheduleColumns({
  campaignNames,
  canWrite,
  onToggle,
}: {
  campaignNames: ReadonlyMap<string, string>;
  canWrite: boolean;
  onToggle: (schedule: RedTeamSchedule) => void;
}): ReadonlyArray<DataTableColumn<RedTeamSchedule>> {
  const column = createDataTableColumnHelper<RedTeamSchedule>();
  const writeTitle = canWrite ? undefined : writeDeniedReason;
  return column.columns([
    column.accessor((row) => row.campaign_template_id, {
      id: "campaign",
      header: "캠페인",
      cell: ({ row }) => (
        <div className="rt-stacked-cell">
          <strong>{campaignNames.get(row.original.campaign_template_id) ?? "(삭제된 캠페인)"}</strong>
          <code className="mono">{row.original.campaign_template_id}</code>
        </div>
      ),
    }),
    column.accessor((row) => row.cron_expr, {
      id: "cron_expr",
      header: "주기",
      cell: ({ getValue }) => <code className="mono">{getValue() || "@daily"}</code>,
    }),
    column.accessor((row) => row.timezone, {
      id: "timezone",
      header: "시간대",
      cell: ({ getValue }) => getValue() || "Asia/Seoul",
    }),
    column.accessor((row) => row.enabled, {
      id: "enabled",
      header: "상태",
      cell: ({ getValue }) => (
        <Badge tone={getValue() ? "success" : "warning"}>{getValue() ? "활성" : "중지"}</Badge>
      ),
    }),
    column.accessor((row) => row.last_run_at, {
      id: "last_run_at",
      header: "최근 실행",
      cell: ({ getValue }) =>
        getValue() === "" ? "미실행" : <span title={getValue()}>{formatRelative(getValue())}</span>,
    }),
    column.display({
      id: "actions",
      header: "작업",
      cell: ({ row }) => (
        <Button
          size="small"
          disabled={!canWrite}
          title={writeTitle}
          aria-label={`${campaignNames.get(row.original.campaign_template_id) ?? row.original.id} 일정 ${row.original.enabled ? "중지" : "활성화"}`}
          onClick={() => onToggle(row.original)}
        >
          {row.original.enabled ? "중지" : "활성화"}
        </Button>
      ),
    }),
  ]);
}
