import { TableStateCell } from "@/shared/data-table/TableStateCell";
import { Trash2 } from "lucide-react";
import { useMemo, useRef } from "react";

import { QueryNotice, UpdatedAt } from "@/features/system/settings/SettingsParts";
import { routeId, systemSettingsKeys, useSystemErrors } from "@/features/system/settings/use-system-settings";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { SettingsRecordBoundary } from "./SettingsRecordBoundary";
import { useRecordActionReview } from "./use-record-action-review";
import { featureOwnedKey, type FeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { formatDateTime, formatNumber } from "@/shared/utils/format";

const system = endpoints.domains.system;

export function SystemErrorsTab({ hasAdminWrite }: { hasAdminWrite: boolean }): React.JSX.Element {
  return (
    <SettingsRecordBoundary marker="system-errors-workspace">
      {(owner) => <SystemErrorsWorkspace owner={owner} hasAdminWrite={hasAdminWrite} />}
    </SettingsRecordBoundary>
  );
}
function SystemErrorsWorkspace({
  owner,
  hasAdminWrite,
}: {
  owner: FeatureReadOwner;
  hasAdminWrite: boolean;
}): React.JSX.Element {
  const errors = useSystemErrors(owner);
  const clearTriggerRef = useRef<HTMLButtonElement | null>(null);

  const rows = useMemo(() => errors.data?.errors ?? [], [errors.data?.errors]);
  const byComponent = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of rows) {
      const component = row.component || "unknown";
      counts.set(component, (counts.get(component) ?? 0) + 1);
    }
    return [...counts.entries()].sort((left, right) => right[1] - left[1]);
  }, [rows]);

  const key = featureOwnedKey(systemSettingsKeys.errors, owner);
  const clearErrors = useRecordActionReview<NonNullable<typeof errors.data>, "clear">({
    owner,
    query: errors,
    queryKey: key,
    hasAdminWrite,
    execute: async () => apiClient.request(system.systemErrors.clear, { routeId, retryUnauthorized: false }),
    invalidates: [key],
    successMessage: "시스템 오류 로그를 비웠습니다.",
  });

  return (
    <div className="settings-tab-stack">
      <StatGrid label="시스템 오류 요약">
        <StatCard
          label="조회된 오류"
          value={errors.data ? formatNumber(rows.length) : "—"}
          tone={rows.length > 0 ? "danger" : "default"}
        />
        <StatCard label="영향 컴포넌트" value={errors.data ? formatNumber(byComponent.length) : "—"} />
        <StatCard label="최근 오류" value={rows[0] ? formatDateTime(rows[0].created_at) : "—"} />
      </StatGrid>

      {errors.isError ? (
        <QueryNotice
          error={errors.error}
          hasPreviousData={Boolean(errors.data)}
          label="시스템 오류 로그"
          onRetry={() => void errors.refetch()}
        />
      ) : null}

      <SectionCard
        title="시스템 오류 로그"
        headingLevel={2}
        description="게이트웨이 내부 작업에서 발생한 최근 오류를 최대 100건 표시합니다. 전체 비우기는 표시 범위 밖의 기록도 삭제합니다."
        actions={
          <Button
            ref={clearTriggerRef}
            size="small"
            variant="danger"
            disabled={!clearErrors.available || rows.length === 0}
            onClick={() => clearErrors.open("clear")}
          >
            <Trash2 aria-hidden="true" /> 전체 비우기
          </Button>
        }
      >
        {byComponent.length > 0 ? (
          <ul className="badge-list settings-component-counts">
            {byComponent.map(([component, count]) => (
              <li key={component}>
                <span className="mono">{component}</span> {formatNumber(count)}건
              </li>
            ))}
          </ul>
        ) : null}

        {errors.isSuccess && rows.length === 0 ? (
          <EmptyState
            title="기록된 시스템 오류가 없습니다."
            description="게이트웨이 내부 작업이 실패하면 이곳에 남습니다."
          />
        ) : (
          <div className="data-table-scroll" role="region" aria-label="시스템 오류 로그 표" tabIndex={0}>
            <table className="data-table">
              <caption className="sr-only">시스템 오류 로그</caption>
              <thead>
                <tr>
                  <th scope="col">시각</th>
                  <th scope="col">컴포넌트</th>
                  <th scope="col">오류 메시지</th>
                </tr>
              </thead>
              <tbody>
                {errors.isPending ? (
                  <tr>
                    <TableStateCell colSpan={3}>
                      <span role="status">시스템 오류를 불러오는 중입니다.</span>
                    </TableStateCell>
                  </tr>
                ) : (
                  rows.map((row) => (
                    <tr key={row.id}>
                      <td>{formatDateTime(row.created_at)}</td>
                      <td className="mono">{row.component || "—"}</td>
                      <td>{row.error_message || "—"}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
        {clearErrors.reason ? <p className="settings-permission-note">{clearErrors.reason}</p> : null}
        <UpdatedAt at={errors.dataUpdatedAt} />
      </SectionCard>

      {clearErrors.attempted ? (
        <InlineNotice tone="warning">
          전송한 작업은 일부 완료됐을 수 있습니다. 다시 실행하려면 기록을 새로고침하고 확인창을 다시 여세요.
        </InlineNotice>
      ) : null}
      <ConfirmDialog
        open={clearErrors.review !== undefined}
        onOpenChange={(open) => {
          if (!open) clearErrors.close();
        }}
        confirmDisabled={!clearErrors.current}
        title="시스템 오류 로그 전체 비우기"
        description="기록된 모든 시스템 오류를 삭제합니다. 삭제한 기록은 복구할 수 없습니다."
        confirmLabel="전체 비우기"
        tone="danger"
        returnFocusRef={clearTriggerRef}
        onConfirm={clearErrors.confirm}
      >
        <p>
          현재 조회한 기록은 최대 100건이며, 삭제할 전체 건수를 뜻하지 않습니다. 처리 시점에 추가된 기록도
          함께 삭제될 수 있습니다.
        </p>
        {!clearErrors.current ? (
          <p role="status">권한 또는 조회 상태가 변경되었습니다. 기록을 새로고침한 뒤 다시 확인하세요.</p>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}
