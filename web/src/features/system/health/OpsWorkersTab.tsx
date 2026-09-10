import { useQuery } from "@tanstack/react-query";
import { PlayCircle } from "lucide-react";
import { useState } from "react";

import { QueryNotice, UpdatedAt } from "@/features/system/settings/SettingsParts";
import { opsRouteId } from "@/features/system/health/OpsHomeTab";
import { bySeverity, opsStatusLabel, opsStatusTone } from "@/features/system/health/ops-status";
import { apiClient } from "@/shared/api/client";
import type { OpsWorkerRow } from "@/shared/api/domains/system.schemas";
import { endpoints } from "@/shared/api/endpoints";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import { DataTable } from "@/shared/data-table/DataTable";
import { formatInteger } from "@/features/health/health-utils";
import { formatRelative } from "@/shared/utils/format";

function workerColumns(): ReadonlyArray<DataTableColumn<OpsWorkerRow>> {
  const column = createDataTableColumnHelper<OpsWorkerRow>();
  return column.columns([
    column.accessor((row) => row.name, {
      id: "name",
      header: "워커",
      cell: ({ row }) => <span className="mono">{row.original.name}</span>,
    }),
    column.accessor((row) => row.status ?? "", {
      id: "status",
      header: "상태",
      cell: ({ row }) => (
        <Badge tone={opsStatusTone(row.original.status)}>{opsStatusLabel(row.original.status)}</Badge>
      ),
    }),
    column.accessor((row) => (row.running ? "실행" : "중지"), {
      id: "running",
      header: "실행",
    }),
    column.accessor((row) => row.queue_depth ?? 0, {
      id: "queue",
      header: "큐",
      cell: ({ row }) =>
        row.original.capacity
          ? `${formatInteger(row.original.queue_depth ?? 0)} / ${formatInteger(row.original.capacity)}`
          : formatInteger(row.original.queue_depth ?? 0),
    }),
    column.accessor((row) => row.dropped ?? 0, {
      id: "dropped",
      header: "유실",
      cell: ({ row }) => formatInteger(row.original.dropped ?? 0),
    }),
    column.accessor((row) => row.detail ?? "", {
      id: "detail",
      header: "상세",
      cell: ({ row }) => (
        <span className="metric-note">
          {row.original.last_run ? `${formatRelative(row.original.last_run)} · ` : ""}
          {row.original.detail ?? ""}
        </span>
      ),
    }),
  ]);
}

const columns = workerColumns();

/**
 * Background workers and the pre-deploy checklist. The preflight check is a read-only
 * report the operator asks for, so it is fetched on demand rather than on every render.
 */
export function OpsWorkersTab(): React.JSX.Element {
  const [preflightRequested, setPreflightRequested] = useState(false);

  const workers = useQuery({
    queryKey: ["system", "ops", "workers"],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.system.ops.workers, { routeId: opsRouteId, signal }),
  });
  const preflight = useQuery({
    enabled: preflightRequested,
    queryKey: ["system", "ops", "preflight"],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.system.ops.preflight, { routeId: opsRouteId, signal }),
  });

  const rows = [...(workers.data?.workers ?? [])].sort((left, right) =>
    bySeverity(left.status, right.status),
  );
  const checks = [...(preflight.data?.checks ?? [])].sort((left, right) =>
    bySeverity(left.status, right.status),
  );

  return (
    <div className="page-stack">
      {workers.isError ? (
        <QueryNotice
          error={workers.error}
          hasPreviousData={workers.data !== undefined}
          label="워커 상태"
          onRetry={() => void workers.refetch()}
        />
      ) : null}

      <SectionCard
        title="백그라운드 워커"
        description="큐 깊이와 유실 건수는 게이트웨이가 뒤에서 처리하는 일이 밀리고 있는지 보여줍니다."
        actions={
          workers.data ? (
            <Badge tone={opsStatusTone(workers.data.overall)}>{opsStatusLabel(workers.data.overall)}</Badge>
          ) : null
        }
      >
        <DataTable
          caption="백그라운드 워커 상태"
          columns={columns}
          data={rows}
          getRowId={(row) => row.name}
          loading={workers.isPending}
          emptyMessage="표시할 워커가 없습니다."
        />
        <UpdatedAt at={workers.dataUpdatedAt} />
      </SectionCard>

      <SectionCard
        title="배포 프리플라이트"
        description="폐쇄망 배포 전후 점검용 읽기 전용 확인입니다. 실패가 있으면 배포를 보류하거나 롤백을 검토하세요."
        actions={
          <Button
            size="small"
            onClick={() => {
              setPreflightRequested(true);
              if (preflightRequested) void preflight.refetch();
            }}
            disabled={preflight.isFetching}
          >
            <PlayCircle aria-hidden="true" /> 점검 실행
          </Button>
        }
      >
        {preflight.isError ? (
          <QueryNotice
            error={preflight.error}
            hasPreviousData={preflight.data !== undefined}
            label="프리플라이트"
            onRetry={() => void preflight.refetch()}
          />
        ) : null}
        {!preflightRequested ? (
          <EmptyState
            title="아직 점검하지 않았습니다."
            description="점검 실행을 누르면 DB·마이그레이션·설정 상태를 확인합니다."
          />
        ) : preflight.isPending ? (
          <p className="metric-note">점검 중…</p>
        ) : (
          <>
            <p className="metric-note">
              {preflight.data?.version ? `버전 ${preflight.data.version} · ` : ""}
              종합{" "}
              <Badge tone={opsStatusTone(preflight.data?.overall)}>
                {opsStatusLabel(preflight.data?.overall)}
              </Badge>
            </p>
            <table className="ops-check-table">
              <caption className="sr-only">프리플라이트 점검 결과</caption>
              <thead>
                <tr>
                  <th scope="col">점검</th>
                  <th scope="col">상태</th>
                  <th scope="col">상세</th>
                </tr>
              </thead>
              <tbody>
                {checks.map((check) => (
                  <tr key={check.name}>
                    <td className="mono">{check.name}</td>
                    <td>
                      <Badge tone={opsStatusTone(check.status)}>{opsStatusLabel(check.status)}</Badge>
                    </td>
                    <td className="metric-note">{check.detail ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {preflight.data?.note ? <p className="metric-note">{preflight.data.note}</p> : null}
          </>
        )}
      </SectionCard>
    </div>
  );
}
