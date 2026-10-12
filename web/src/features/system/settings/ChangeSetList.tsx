import { Plus } from "lucide-react";
import type { RefObject } from "react";
import type { ChangeSet } from "@/shared/api/domains/system.schemas";
import type { useChangeSets } from "./use-system-settings";
import { QueryNotice, UpdatedAt } from "./SettingsParts";
import { formatDateTime, formatNumber } from "@/shared/utils/format";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { changeSetStatusLabel, statusTones } from "./change-set-model";

export function ChangeSetList({
  changeSets,
  rows,
  canCreate,
  createTriggerRef,
  onCreate,
  onSelect,
}: {
  changeSets: ReturnType<typeof useChangeSets>;
  rows: ChangeSet[];
  canCreate: boolean;
  createTriggerRef: RefObject<HTMLButtonElement | null>;
  onCreate: () => void;
  onSelect: (id: string, target: HTMLElement) => void;
}): React.JSX.Element {
  const counts = {
    total: rows.length,
    pending: rows.filter((row) => row.status === "pending").length,
    approved: rows.filter((row) => row.status === "approved").length,
    applied: rows.filter((row) => row.status === "applied").length,
  };
  return (
    <>
      <StatGrid label="변경 세트 요약">
        <StatCard label="전체" value={formatNumber(counts.total)} />
        <StatCard label="검토 대기" value={formatNumber(counts.pending)} tone="warning" />
        <StatCard label="승인됨" value={formatNumber(counts.approved)} tone="info" />
        <StatCard label="적용됨" value={formatNumber(counts.applied)} tone="success" />
      </StatGrid>

      {changeSets.isError ? (
        <QueryNotice
          error={changeSets.error}
          hasPreviousData={Boolean(changeSets.data)}
          label="변경 세트 목록"
          onRetry={() => void changeSets.refetch()}
        />
      ) : null}

      <SectionCard
        title="변경 세트"
        headingLevel={3}
        description="여러 설정 변경을 하나의 승인 단위로 묶습니다."
        actions={
          <>
            <Button size="small" disabled={changeSets.isFetching} onClick={() => void changeSets.refetch()}>
              {changeSets.isFetching ? "새로고침 중" : "목록 새로고침"}
            </Button>
            <Button
              ref={createTriggerRef}
              size="small"
              variant="primary"
              disabled={!canCreate}
              onClick={onCreate}
            >
              <Plus aria-hidden="true" /> 새 변경 세트
            </Button>
          </>
        }
      >
        {!changeSets.isPending && rows.length === 0 ? (
          <EmptyState
            title="아직 변경 세트가 없습니다."
            description="설정 변경을 묶어 승인 절차를 거치려면 새 변경 세트를 만드세요."
          />
        ) : (
          <div className="data-table-scroll" role="region" aria-label="변경 세트 목록 표" tabIndex={0}>
            <table className="data-table">
              <caption className="sr-only">변경 세트 목록</caption>
              <thead>
                <tr>
                  <th scope="col">제목</th>
                  <th scope="col">상태</th>
                  <th scope="col">항목 수</th>
                  <th scope="col">생성자</th>
                  <th scope="col">생성</th>
                  <th scope="col">적용</th>
                  <th scope="col">작업</th>
                </tr>
              </thead>
              <tbody>
                {changeSets.isPending ? (
                  <tr>
                    <td colSpan={7} className="data-table-state">
                      <span role="status">변경 세트를 불러오는 중입니다.</span>
                    </td>
                  </tr>
                ) : (
                  rows.map((row: ChangeSet) => (
                    <tr key={row.id}>
                      <th scope="row">{row.title || row.id}</th>
                      <td>
                        <Badge tone={statusTones[row.status ?? ""] ?? "muted"}>
                          {changeSetStatusLabel(row.status)}
                        </Badge>
                      </td>
                      <td className="cell-number">{formatNumber(row.items?.length ?? 0)}</td>
                      <td>{row.created_by || "—"}</td>
                      <td>{formatDateTime(row.created_at)}</td>
                      <td>{formatDateTime(row.applied_at)}</td>
                      <td>
                        <Button
                          size="small"
                          variant="ghost"
                          aria-label={`${row.title || row.id} 상세`}
                          onClick={(event) => {
                            onSelect(row.id, event.currentTarget);
                          }}
                        >
                          상세
                        </Button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
        <UpdatedAt at={changeSets.dataUpdatedAt} />
      </SectionCard>
    </>
  );
}
