import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { useCallback, useMemo, useRef } from "react";

import { QuerySection, ScopeNotice } from "@/features/security/security-ui";
import {
  isSecretAction,
  secretActionLabels,
  secretActionTone,
  securityWindowLabels,
} from "@/features/security/overview/security-overview";
import { apiClient } from "@/shared/api/client";
import {
  secretEventActions,
  type SecretEvent,
  type SecretEventsQuery,
  type SecurityWindow,
} from "@/shared/api/domains/security";
import { endpoints } from "@/shared/api/endpoints";
import { FormField } from "@/shared/components/form/FormField";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { Sheet } from "@/shared/components/ui/Sheet";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { Toolbar } from "@/shared/components/ui/Toolbar";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import { DataTable } from "@/shared/data-table/DataTable";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { downloadCsv, toCsv } from "@/shared/utils/csv";
import { formatDateTime, formatNumber, formatRelative, shortId } from "@/shared/utils/format";

function secretColumns(): ReadonlyArray<DataTableColumn<SecretEvent>> {
  const column = createDataTableColumnHelper<SecretEvent>();
  return column.columns([
    column.accessor((row) => row.created_at, {
      id: "created_at",
      header: "시각",
      cell: ({ getValue }) => <time title={formatDateTime(getValue())}>{formatRelative(getValue())}</time>,
    }),
    column.accessor((row) => row.secret_type, { id: "secret_type", header: "유형" }),
    column.accessor((row) => row.action, {
      id: "action",
      header: "조치",
      cell: ({ getValue }) => (
        <Badge tone={secretActionTone(getValue())}>{secretActionLabels[getValue()] ?? getValue()}</Badge>
      ),
    }),
    column.accessor((row) => row.location, { id: "location", header: "위치" }),
    column.accessor((row) => row.team_id, { id: "team", header: "팀" }),
    column.accessor((row) => row.request_id, {
      id: "request_id",
      header: "요청",
      cell: ({ getValue }) => (
        <span className="cell-mono" title={getValue()}>
          {shortId(getValue())}
        </span>
      ),
    }),
  ]) as Array<DataTableColumn<SecretEvent>>;
}

interface SecretEventsTabProps {
  canRead: boolean;
  range: SecurityWindow;
  refreshInterval: number | false;
}

export function SecretEventsTab({
  canRead,
  range,
  refreshInterval,
}: SecretEventsTabProps): React.JSX.Element {
  const [params, updateSearch] = useSearchState();
  const requestedAction = params.get("action");
  const action = isSecretAction(requestedAction) ? requestedAction : undefined;
  const selectedId = params.get("event") ?? "";
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const query: SecretEventsQuery = { window: range, limit: 200, ...(action ? { action } : {}) };
  const events = useQuery({
    queryKey: ["security", "secret-events", range, action ?? "all"],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.security.secretEvents, {
        query,
        signal,
        routeId: "security.overview",
      }),
    enabled: canRead,
    refetchInterval: refreshInterval,
    refetchIntervalInBackground: false,
  });

  const rows = useMemo(() => events.data?.secret_events ?? [], [events.data]);
  const selected = rows.find((row) => row.id === selectedId);

  const exportCsv = useCallback((): void => {
    downloadCsv(
      `secret-events-${range}.csv`,
      toCsv(rows, [
        { header: "created_at", value: (row) => row.created_at },
        { header: "secret_type", value: (row) => row.secret_type },
        { header: "action", value: (row) => row.action },
        { header: "location", value: (row) => row.location },
        { header: "team_id", value: (row) => row.team_id },
        { header: "api_key_id", value: (row) => row.api_key_id },
        { header: "request_id", value: (row) => row.request_id },
        { header: "matched_hash", value: (row) => row.matched_hash },
      ]),
    );
  }, [range, rows]);

  if (!canRead) return <ScopeNotice scope="security:read" what="비밀정보 탐지 기록" />;

  const counts = rows.reduce<Record<string, number>>((totals, row) => {
    totals[row.action] = (totals[row.action] ?? 0) + 1;
    return totals;
  }, {});

  return (
    <>
      <Toolbar
        label="비밀정보 탐지 필터"
        end={
          <Button size="small" onClick={exportCsv} disabled={rows.length === 0}>
            <Download aria-hidden="true" /> CSV 내보내기
          </Button>
        }
      >
        <FormField label="조치">
          {(control) => (
            <Select
              {...control}
              value={action ?? ""}
              onChange={(event) => updateSearch({ action: event.target.value || undefined })}
            >
              <option value="">전체 조치</option>
              {secretEventActions.map((value) => (
                <option key={value} value={value}>
                  {secretActionLabels[value]}
                </option>
              ))}
            </Select>
          )}
        </FormField>
      </Toolbar>

      <QuerySection
        error={events.isError ? events.error : undefined}
        hasData={Boolean(events.data)}
        label="비밀정보 탐지 기록"
        onRetry={() => void events.refetch()}
        pending={events.isPending}
      >
        <StatGrid label="비밀정보 탐지 요약">
          <StatCard label="전체" value={formatNumber(events.data?.count ?? rows.length)} />
          {secretEventActions.map((value) => (
            <StatCard
              key={value}
              label={secretActionLabels[value] ?? value}
              tone={value === "block" ? "danger" : value === "mask" ? "warning" : "default"}
              value={formatNumber(counts[value] ?? 0)}
            />
          ))}
        </StatGrid>

        <SectionCard
          title={`비밀정보 탐지 (${securityWindowLabels[range]})`}
          description="탐지된 값의 원문은 저장되지 않으며 대조용 해시만 남습니다."
        >
          <DataTable
            caption="비밀정보 탐지 기록"
            columns={secretColumns()}
            data={rows}
            emptyMessage="탐지된 비밀정보가 없습니다."
            getRowId={(row, index) => row.id || `secret-${index}`}
            getRowActionLabel={(row) => `${row.secret_type} 탐지 상세 보기`}
            onRowClick={(row) => updateSearch({ event: row.id })}
          />
        </SectionCard>
      </QuerySection>

      <Sheet
        open={selectedId !== ""}
        onOpenChange={(open) => {
          if (!open) updateSearch({ event: undefined });
        }}
        returnFocusRef={returnFocusRef}
        title="비밀정보 탐지 상세"
        description="탐지 시점의 메타데이터입니다. 원문은 포함되지 않습니다."
      >
        {selected ? (
          <KeyValueList
            items={[
              { label: "유형", value: selected.secret_type },
              { label: "조치", value: secretActionLabels[selected.action] ?? selected.action },
              { label: "위치", value: selected.location },
              { label: "탐지 시각", value: formatDateTime(selected.created_at) },
              { label: "요청 ID", value: selected.request_id, mono: true },
              { label: "API 키 ID", value: selected.api_key_id, mono: true },
              { label: "사용자", value: selected.user_id, mono: true },
              { label: "팀", value: selected.team_id, mono: true },
              { label: "대조 해시", value: selected.matched_hash, mono: true },
            ]}
          />
        ) : (
          <p role="status">선택한 탐지 기록을 찾을 수 없습니다.</p>
        )}
      </Sheet>
    </>
  );
}
