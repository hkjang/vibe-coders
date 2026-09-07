import { Trash2 } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { QueryNotice, UpdatedAt } from "@/features/system/settings/SettingsParts";
import { routeId, systemSettingsKeys, useSystemErrors } from "@/features/system/settings/use-system-settings";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { formatDateTime, formatNumber } from "@/shared/utils/format";

const system = endpoints.domains.system;

export function SystemErrorsTab({ hasAdminWrite }: { hasAdminWrite: boolean }): React.JSX.Element {
  const errors = useSystemErrors();
  const clearTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const rows = useMemo(() => errors.data?.errors ?? [], [errors.data?.errors]);
  const byComponent = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of rows) {
      const component = row.component || "unknown";
      counts.set(component, (counts.get(component) ?? 0) + 1);
    }
    return [...counts.entries()].sort((left, right) => right[1] - left[1]);
  }, [rows]);

  const clearErrors = useMutationFeedback({
    mutate: async () => apiClient.request(system.systemErrors.clear, { routeId }),
    invalidates: [systemSettingsKeys.errors],
    successMessage: "시스템 오류 로그를 비웠습니다.",
    errorMessage: "시스템 오류 로그를 비우지 못했습니다.",
  });

  return (
    <div className="settings-tab-stack">
      <StatGrid label="시스템 오류 요약">
        <StatCard
          label="오류 건수"
          value={formatNumber(rows.length)}
          tone={rows.length > 0 ? "danger" : "default"}
        />
        <StatCard label="영향 컴포넌트" value={formatNumber(byComponent.length)} />
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
        headingLevel={3}
        description="게이트웨이 내부 작업(적재·정리·연동)에서 발생한 오류입니다."
        actions={
          <Button
            ref={clearTriggerRef}
            size="small"
            variant="danger"
            disabled={!hasAdminWrite || rows.length === 0 || clearErrors.isPending}
            onClick={() => setConfirmClear(true)}
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

        {!errors.isPending && rows.length === 0 ? (
          <EmptyState
            title="기록된 시스템 오류가 없습니다."
            description="게이트웨이 내부 작업이 실패하면 이곳에 남습니다."
          />
        ) : (
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
                  <td colSpan={3} className="data-table-state">
                    <span role="status">시스템 오류를 불러오는 중입니다.</span>
                  </td>
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
        )}
        <UpdatedAt at={errors.dataUpdatedAt} />
      </SectionCard>

      <ConfirmDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title="시스템 오류 로그 전체 비우기"
        description="기록된 모든 시스템 오류를 삭제합니다. 삭제한 기록은 복구할 수 없습니다."
        confirmLabel="전체 비우기"
        tone="danger"
        returnFocusRef={clearTriggerRef}
        onConfirm={async () => {
          await clearErrors.mutateAsync(undefined);
        }}
      />
    </div>
  );
}
