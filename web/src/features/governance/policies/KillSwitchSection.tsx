import { useQuery } from "@tanstack/react-query";
import { OctagonAlert, Play } from "lucide-react";
import { useRef, useState } from "react";

import {
  GovernanceTable,
  PanelFailure,
  type GovernanceColumn,
} from "@/features/governance/policies/governance-parts";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { formatDateTime, formatNumber, formatRelative } from "@/shared/utils/format";

const routeId = "governance.policies";

export function KillSwitchSection({ canWrite }: { canWrite: boolean }): React.JSX.Element {
  const [confirming, setConfirming] = useState<"stop" | "resume" | undefined>();
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const killSwitch = useQuery({
    queryKey: ["governance", "kill-switch"],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.governance.killSwitch.get, { signal, routeId }),
  });
  const incidents = useQuery({
    queryKey: ["governance", "incidents", "7d"],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.governance.incidents, {
        query: { window: "7d" },
        signal,
        routeId,
      }),
  });

  const setKillSwitch = useMutationFeedback({
    mutate: (variables: { disabled: boolean; reason: string }) =>
      apiClient.request(endpoints.domains.governance.killSwitch.set, {
        body: variables,
        routeId,
      }),
    invalidates: [["governance", "kill-switch"]],
    successMessage: (_result, variables) =>
      variables.disabled ? "게이트웨이를 긴급 정지했습니다." : "게이트웨이 운영을 재개했습니다.",
    errorMessage: "긴급 정지 상태를 변경하지 못했습니다.",
  });

  const disabled = killSwitch.data?.disabled === true;
  const incidentRows = incidents.data?.incidents ?? [];

  const incidentColumns: ReadonlyArray<GovernanceColumn<(typeof incidentRows)[number]>> = [
    { id: "provider", header: "공급자", cell: (row) => row.provider || "—" },
    { id: "started", header: "시작", cell: (row) => formatDateTime(row.started_at) },
    { id: "ended", header: "종료", cell: (row) => formatDateTime(row.ended_at) },
    {
      id: "failovers",
      header: "폴백",
      cell: (row) => <span className="cell-number">{formatNumber(row.failovers)}</span>,
    },
    {
      id: "errors",
      header: "5xx",
      cell: (row) => <span className="cell-number">{formatNumber(row.errors_5xx)}</span>,
    },
    {
      id: "users",
      header: "영향 사용자",
      cell: (row) => <span className="cell-number">{formatNumber(row.affected_users)}</span>,
    },
    {
      id: "ongoing",
      header: "상태",
      cell: (row) => (row.ongoing ? <Badge tone="danger">진행 중</Badge> : <Badge tone="muted">종료</Badge>),
    },
  ];

  return (
    <>
      <SectionCard
        title="긴급 정지 (Kill Switch)"
        description="차단 중에는 모든 /v1 호출이 HTTP 503 + Retry-After 60 + X-Kill-Switch=global 헤더로 응답합니다."
        actions={
          disabled ? (
            <Button
              variant="primary"
              disabled={!canWrite}
              title={canWrite ? undefined : "admin:write 권한이 필요합니다."}
              onClick={(event) => {
                triggerRef.current = event.currentTarget;
                setConfirming("resume");
              }}
            >
              <Play aria-hidden="true" /> 정상 운영 재개
            </Button>
          ) : (
            <Button
              variant="danger"
              disabled={!canWrite}
              title={canWrite ? undefined : "admin:write 권한이 필요합니다."}
              onClick={(event) => {
                triggerRef.current = event.currentTarget;
                setConfirming("stop");
              }}
            >
              <OctagonAlert aria-hidden="true" /> 모든 /v1 호출 즉시 차단
            </Button>
          )
        }
      >
        {killSwitch.isError ? (
          <PanelFailure
            error={killSwitch.error}
            hasData={Boolean(killSwitch.data)}
            label="긴급 정지 상태"
            onRetry={() => void killSwitch.refetch()}
          />
        ) : null}
        {killSwitch.isPending ? (
          <p role="status">긴급 정지 상태를 확인하는 중입니다.</p>
        ) : (
          <>
            {disabled ? (
              <InlineNotice tone="danger" title="게이트웨이가 정지 상태입니다.">
                모든 /v1 호출이 차단되고 있습니다. 원인을 해결한 뒤 운영을 재개하세요.
              </InlineNotice>
            ) : null}
            <KeyValueList
              items={[
                {
                  label: "현재 상태",
                  value: disabled ? (
                    <Badge tone="danger">정지 중</Badge>
                  ) : (
                    <Badge tone="success">정상 운영</Badge>
                  ),
                },
                { label: "사유", value: killSwitch.data?.reason || "—" },
                {
                  label: "변경 시각",
                  value: killSwitch.data?.updated_at
                    ? `${formatRelative(killSwitch.data.updated_at)} (${formatDateTime(killSwitch.data.updated_at)})`
                    : "—",
                },
                { label: "변경자", value: killSwitch.data?.updated_by || "—" },
              ]}
            />
          </>
        )}
      </SectionCard>

      <SectionCard
        title="AI Incident (공급자 장애 감지, 최근 7일)"
        description="폴백과 5xx가 몰린 구간을 공급자별로 묶어 보여줍니다."
      >
        {incidents.isError ? (
          <PanelFailure
            error={incidents.error}
            hasData={Boolean(incidents.data)}
            label="AI Incident"
            onRetry={() => void incidents.refetch()}
          />
        ) : null}
        <GovernanceTable
          caption="최근 7일 공급자 장애 후보"
          columns={incidentColumns}
          rows={incidentRows}
          loading={incidents.isPending}
          emptyMessage="최근 7일 동안 감지된 공급자 장애가 없습니다."
        />
      </SectionCard>

      <ConfirmDialog
        open={confirming !== undefined}
        onOpenChange={(open) => {
          if (!open) setConfirming(undefined);
        }}
        returnFocusRef={triggerRef}
        title={confirming === "stop" ? "게이트웨이를 긴급 정지할까요?" : "정상 운영을 재개할까요?"}
        description={
          confirming === "stop"
            ? "모든 사용자와 팀의 /v1 호출이 즉시 차단됩니다. 최후의 수단으로만 사용하세요."
            : "차단을 해제하고 모든 /v1 호출을 다시 허용합니다."
        }
        confirmLabel={confirming === "stop" ? "즉시 차단" : "운영 재개"}
        tone="danger"
        requireReason
        onConfirm={async (reason) => {
          await setKillSwitch.mutateAsync({ disabled: confirming === "stop", reason });
        }}
      />
    </>
  );
}
