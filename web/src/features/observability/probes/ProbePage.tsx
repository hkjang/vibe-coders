import { useQuery } from "@tanstack/react-query";
import { PlayCircle, RefreshCw } from "lucide-react";
import { useId, useState } from "react";

import { useAuth } from "@/app/auth/AuthProvider";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import type { JourneyProbeResponse, PodsResponse } from "@/shared/api/domains/observability.schemas";
import { isAppError } from "@/shared/api/error";
import { FormField } from "@/shared/components/form/FormField";
import { ErrorState, LoadingState } from "@/shared/components/state/PageStates";
import { PageHeader } from "@/shared/components/page/PageHeader";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { Checkbox } from "@/shared/components/ui/Checkbox";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { TabPanel, Tabs } from "@/shared/components/ui/Tabs";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import { DataTable } from "@/shared/data-table/DataTable";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { useRefreshInterval } from "@/shared/hooks/use-refresh-interval";
import { useTabParam } from "@/shared/hooks/use-tab-param";
import { formatDateTime, formatNumber, formatRelative } from "@/shared/utils/format";
import "@/features/observability/observability.css";

const tabIds = ["journey", "pods"] as const;
type TabId = (typeof tabIds)[number];

/** journeyDefs in internal/proxy/admin_journey_probe.go. */
const journeyClients = [
  { id: "openai-sdk", label: "OpenAI SDK" },
  { id: "cursor", label: "Cursor" },
  { id: "continue", label: "Continue" },
  { id: "roo", label: "Roo Code" },
  { id: "cline", label: "Cline" },
  { id: "claude-desktop-mcp", label: "Claude Desktop (MCP)" },
] as const;

type PodRow = PodsResponse["pods"][number];

function statusTone(status: string): "danger" | "success" | "warning" {
  if (status === "fail") return "danger";
  if (status === "warn") return "warning";
  return "success";
}

function statusLabel(status: string): string {
  if (status === "fail") return "실패";
  if (status === "warn") return "경고";
  if (status === "pass") return "정상";
  return status || "—";
}

const podColumns = ((): ReadonlyArray<DataTableColumn<PodRow>> => {
  const column = createDataTableColumnHelper<PodRow>();
  return column.columns([
    column.display({
      id: "hostname",
      header: "호스트",
      cell: ({ row }) => <span className="mono truncate">{row.original.hostname || "—"}</span>,
    }),
    column.display({
      id: "build_version",
      header: "빌드",
      cell: ({ row }) => row.original.build_version || "—",
    }),
    column.display({
      id: "state",
      header: "하트비트",
      cell: ({ row }) =>
        row.original.stale ? <Badge tone="warning">지연</Badge> : <Badge tone="success">정상</Badge>,
    }),
    column.display({
      id: "converged",
      header: "설정 수렴",
      cell: ({ row }) =>
        row.original.up_to_date ? (
          <Badge tone="success">최신</Badge>
        ) : (
          <Badge tone="warning">적용 대기</Badge>
        ),
    }),
    column.display({
      id: "reload_interval_s",
      header: "재적용 주기(초)",
      cell: ({ row }) => <span className="cell-number">{formatNumber(row.original.reload_interval_s)}</span>,
    }),
    column.display({
      id: "last_seen",
      header: "마지막 하트비트",
      cell: ({ row }) => (
        <span title={formatDateTime(row.original.last_seen)}>{formatRelative(row.original.last_seen)}</span>
      ),
    }),
  ]);
})();

function JourneyProbePanel(): React.JSX.Element {
  const auth = useAuth();
  const canRun = auth.mode !== "authenticated" || (auth.user?.scopes.includes("admin:write") ?? false);
  const keyFieldId = useId();
  const [proxyKey, setProxyKey] = useState("");
  const [selected, setSelected] = useState<readonly string[]>(journeyClients.map((item) => item.id));
  const [result, setResult] = useState<JourneyProbeResponse>();

  const probe = useMutationFeedback<{ proxyKey: string; clients: readonly string[] }, JourneyProbeResponse>({
    mutate: ({ proxyKey: key, clients }) =>
      apiClient.request(endpoints.domains.observability.probes.journey, {
        body: { proxy_key: key, clients: [...clients] },
        routeId: "observability.probes.journey",
      }),
    successMessage: "연결 점검을 실행했습니다.",
    errorMessage: "연결 점검을 실행하지 못했습니다.",
    onSuccess: (data) => setResult(data),
  });

  const submit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!canRun || proxyKey.trim() === "") return;
    probe.mutate({ proxyKey: proxyKey.trim(), clients: selected });
  };

  const summary = result?.summary;

  return (
    <div className="obs-section-stack">
      <SectionCard
        title="개발도구 연결 합성 점검"
        description="입력한 Proxy API 키로 모델 목록과 MCP initialize/tools 호출을 대신 실행합니다. 비용이 드는 실제 chat 호출은 하지 않습니다."
      >
        {!canRun ? (
          <InlineNotice tone="warning" title="실행 권한이 없습니다.">
            점검 실행에는 admin:write 권한이 필요합니다. 관리자에게 요청하세요.
          </InlineNotice>
        ) : null}
        <form onSubmit={submit} className="obs-section-stack">
          <FormField
            id={keyFieldId}
            label="Proxy API 키"
            required
            description="점검에만 사용하며 저장하거나 주소에 남기지 않습니다."
          >
            {(control) => (
              <Input
                {...control}
                type="password"
                autoComplete="off"
                value={proxyKey}
                onChange={(event) => setProxyKey(event.target.value)}
                placeholder="점검할 Proxy API 키"
              />
            )}
          </FormField>
          <fieldset>
            <legend>점검할 개발도구</legend>
            <div className="obs-filter-grid">
              {journeyClients.map((client) => (
                <Checkbox
                  key={client.id}
                  label={client.label}
                  checked={selected.includes(client.id)}
                  onChange={(event) =>
                    setSelected((current) =>
                      event.target.checked
                        ? [...current, client.id]
                        : current.filter((id) => id !== client.id),
                    )
                  }
                />
              ))}
            </div>
          </fieldset>
          <div className="obs-filter-actions">
            <Button
              type="submit"
              variant="primary"
              disabled={!canRun || proxyKey.trim() === "" || selected.length === 0 || probe.isPending}
              title={canRun ? undefined : "admin:write 권한이 필요합니다."}
            >
              <PlayCircle aria-hidden="true" /> {probe.isPending ? "점검 중" : "점검 실행"}
            </Button>
          </div>
        </form>
        {probe.isError ? (
          <p className="form-error" role="alert">
            {safeAppErrorMessage(probe.error, "연결 점검을 실행하지 못했습니다.")}
            {isAppError(probe.error) && probe.error.requestId ? (
              <span className="request-id"> 요청 ID: {probe.error.requestId}</span>
            ) : null}
          </p>
        ) : null}
      </SectionCard>

      {result ? (
        <>
          <StatGrid label="점검 요약">
            <StatCard label="점검 대상" value={formatNumber(summary?.clients ?? 0)} />
            <StatCard label="정상" value={formatNumber(summary?.passing ?? 0)} tone="success" />
            <StatCard
              label="실패"
              value={formatNumber(summary?.failing ?? 0)}
              tone={(summary?.failing ?? 0) > 0 ? "danger" : "default"}
            />
          </StatGrid>
          {result.results.length === 0 ? (
            <EmptyState
              title="점검 결과가 없습니다."
              description="점검할 개발도구를 하나 이상 선택한 뒤 다시 실행하세요."
            />
          ) : (
            result.results.map((item) => (
              <SectionCard
                key={item.client}
                title={item.client}
                actions={<Badge tone={statusTone(item.overall)}>{statusLabel(item.overall)}</Badge>}
              >
                <ul className="obs-probe-checks">
                  {item.checks.map((check, index) => (
                    <li key={`${item.client}-${check.name}-${index}`} className="obs-probe-check">
                      <Badge tone={statusTone(check.status)}>{statusLabel(check.status)}</Badge>
                      <div>
                        <strong>{check.name}</strong>
                        <div>{check.detail}</div>
                        {check.fix ? <div className="obs-probe-fix">조치: {check.fix}</div> : null}
                      </div>
                    </li>
                  ))}
                </ul>
              </SectionCard>
            ))
          )}
        </>
      ) : (
        <EmptyState
          title="아직 점검을 실행하지 않았습니다."
          description="Proxy API 키를 입력하고 점검을 실행하면 개발도구별 연결 상태가 표시됩니다."
        />
      )}
    </div>
  );
}

function PodPanel(): React.JSX.Element {
  const interval = useRefreshInterval();
  const pods = useQuery({
    queryKey: ["observability", "pods"],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.observability.probes.pods, {
        signal,
        routeId: "observability.probes.pods",
      }),
    refetchInterval: interval,
    refetchIntervalInBackground: false,
  });

  const summary = pods.data?.summary;

  return (
    <div className="obs-section-stack">
      <StatGrid label="파드 요약">
        <StatCard label="총 파드" value={formatNumber(summary?.total ?? 0)} />
        <StatCard label="정상" value={formatNumber(summary?.live ?? 0)} tone="success" />
        <StatCard
          label="하트비트 지연"
          value={formatNumber(summary?.stale ?? 0)}
          tone={(summary?.stale ?? 0) > 0 ? "warning" : "default"}
        />
        <StatCard label="설정 최신" value={formatNumber(summary?.converged ?? 0)} tone="info" />
      </StatGrid>
      <SectionCard
        title="파드 운영 맵"
        description={pods.data?.note ?? "각 게이트웨이 파드의 하트비트와 런타임 설정 수렴 상태입니다."}
        actions={
          <Button size="small" onClick={() => void pods.refetch()} disabled={pods.isFetching}>
            <RefreshCw aria-hidden="true" /> 새로고침
          </Button>
        }
      >
        {pods.isError ? (
          <InlineNotice
            tone="danger"
            title="파드 목록을 불러오지 못했습니다."
            actions={
              <Button size="small" onClick={() => void pods.refetch()}>
                다시 시도
              </Button>
            }
          >
            {safeAppErrorMessage(pods.error, "파드 목록을 불러오지 못했습니다.")}
            {isAppError(pods.error) && pods.error.requestId ? (
              <span className="request-id"> 요청 ID: {pods.error.requestId}</span>
            ) : null}
          </InlineNotice>
        ) : null}
        {pods.data && pods.data.pods.length === 0 && !pods.isPending ? (
          <EmptyState
            title="등록된 파드가 없습니다."
            description="게이트웨이 파드가 하트비트를 보내면 여기에 표시됩니다."
          />
        ) : (
          <DataTable
            caption="게이트웨이 파드 목록"
            columns={podColumns}
            data={pods.data?.pods ?? []}
            getRowId={(row, index) => row.hostname || String(index)}
            loading={pods.isPending}
            error={pods.isError ? safeAppErrorMessage(pods.error, "파드를 불러오지 못했습니다.") : undefined}
            onRetry={() => void pods.refetch()}
          />
        )}
      </SectionCard>
    </div>
  );
}

export function ProbePage(): React.JSX.Element {
  const [tab, setTab] = useTabParam<TabId>(tabIds);
  const auth = useAuth();

  if (auth.mode === "loading") return <LoadingState />;
  if (auth.mode === "error") {
    return <ErrorState message="인증 상태를 확인하지 못했습니다." legacyHref="/admin#/journey-probe" />;
  }

  return (
    <div className="page-stack">
      <PageHeader
        title="진단 프로브"
        description="개발도구 연결 합성 점검과 게이트웨이 파드 운영 맵을 확인합니다."
        legacyHref="/admin#/journey-probe"
        status="preview"
      />
      <Tabs
        ariaLabel="진단 프로브 화면"
        panelIdPrefix="probe"
        items={[
          { id: "journey", label: "연결 점검" },
          { id: "pods", label: "파드 운영 맵" },
        ]}
        value={tab}
        onChange={setTab}
      />
      <TabPanel id={tab} panelIdPrefix="probe">
        {tab === "journey" ? <JourneyProbePanel /> : <PodPanel />}
      </TabPanel>
    </div>
  );
}
