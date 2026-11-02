import { UsageMeter } from "@/features/access/access-ui";
import { formatSignedRatio } from "@/features/access/access-format";
import type { BudgetStatus, QuotaUsage } from "@/shared/api/domains/access.schemas";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { formatDate, formatKRW, formatNumber } from "@/shared/utils/format";
import { scopeLabels, type QuotaBudgetOperations } from "./use-quota-budget-operations";
function usedRatio(remainRatio: number): number {
  return remainRatio < 0 ? 0 : Math.min(Math.max(1 - remainRatio, 0), 1);
}
export function QuotaUsageTable({
  usage,
  operations,
}: {
  usage: QuotaUsage[];
  operations: QuotaBudgetOperations;
}) {
  const {
    rowTrigger: rowTriggerRef,
    quotaEditForm,
    setEditingQuota,
    setTogglingQuota,
    setRemovingQuota,
  } = operations;
  const allowed = operations.write.allowed;
  const deniedReason = operations.write.reason;
  return (
    <div className="data-table-scroll" tabIndex={0} aria-label="할당량 표 영역">
      <table className="data-table">
        <caption className="sr-only">할당량과 사용량</caption>
        <thead>
          <tr>
            {["범위", "대상", "주기", "상태", "토큰", "비용", "기간", "작업"].map((label) => (
              <th key={label} scope="col">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {usage.map((row) => (
            <tr key={row.quota.id} className={row.quota.enabled ? undefined : "row-muted"}>
              <td>{scopeLabels[row.quota.scope] ?? row.quota.scope}</td>
              <td className="mono truncate">{row.quota.scope_value || "*"}</td>
              <td>{row.quota.period === "daily" ? "일별" : "월별"}</td>
              <td>
                <Badge tone={row.quota.enabled ? "success" : "muted"}>
                  {row.quota.enabled ? "사용" : "중지"}
                </Badge>
              </td>
              <td>
                <div className="cell-number">
                  {formatNumber(row.tokens)}
                  {row.quota.token_limit > 0 ? ` / ${formatNumber(row.quota.token_limit)}` : ""}
                </div>
                {row.token_remain_ratio >= 0 ? (
                  <UsageMeter
                    ratio={usedRatio(row.token_remain_ratio)}
                    label={`${row.quota.scope_value || "전체"} 토큰 사용률`}
                  />
                ) : (
                  <span className="access-note">한도 없음</span>
                )}
              </td>
              <td>
                <div className="cell-number">
                  {formatKRW(row.cost_krw)}
                  {row.quota.krw_limit > 0 ? ` / ${formatKRW(row.quota.krw_limit)}` : ""}
                </div>
                {row.krw_remain_ratio >= 0 ? (
                  <UsageMeter
                    ratio={usedRatio(row.krw_remain_ratio)}
                    label={`${row.quota.scope_value || "전체"} 비용 사용률`}
                  />
                ) : (
                  <span className="access-note">한도 없음</span>
                )}
              </td>
              <td>
                {formatDate(row.period_start)} ~ {formatDate(row.period_end)}
              </td>
              <td>
                <div className="table-actions">
                  <Button
                    size="small"
                    disabled={!allowed}
                    title={deniedReason}
                    onClick={(event) => {
                      rowTriggerRef.current = event.currentTarget;
                      quotaEditForm.reset({
                        token_limit: row.quota.token_limit > 0 ? String(row.quota.token_limit) : "",
                        krw_limit: row.quota.krw_limit > 0 ? String(row.quota.krw_limit) : "",
                        note: row.quota.note,
                        enabled: row.quota.enabled,
                      });
                      setEditingQuota(row);
                    }}
                  >
                    수정
                  </Button>
                  <Button
                    size="small"
                    variant="secondary"
                    disabled={!allowed}
                    title={deniedReason}
                    onClick={(event) => {
                      rowTriggerRef.current = event.currentTarget;
                      setTogglingQuota(row);
                    }}
                  >
                    {row.quota.enabled ? "중지" : "사용"}
                  </Button>
                  <Button
                    size="small"
                    variant="danger"
                    disabled={!allowed}
                    title={deniedReason}
                    onClick={(event) => {
                      rowTriggerRef.current = event.currentTarget;
                      setRemovingQuota(row);
                    }}
                  >
                    삭제
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
export function BudgetUsageTable({
  budgetRows,
  operations,
}: {
  budgetRows: BudgetStatus[];
  operations: QuotaBudgetOperations;
}) {
  const { rowTrigger: rowTriggerRef, setRemovingBudget } = operations;
  const allowed = operations.write.allowed;
  const deniedReason = operations.write.reason;
  return (
    <div className="data-table-scroll" tabIndex={0} aria-label="월 예산 표 영역">
      <table className="data-table">
        <caption className="sr-only">월 예산 소진 현황</caption>
        <thead>
          <tr>
            {["범위", "대상", "월 예산", "사용", "소진율", "예상 지출", "소진 예상일", "작업"].map(
              (label) => (
                <th key={label} scope="col">
                  {label}
                </th>
              ),
            )}
          </tr>
        </thead>
        <tbody>
          {budgetRows.map((row) => (
            <tr key={row.budget.id} className={row.on_track ? undefined : "row-danger"}>
              <td>{scopeLabels[row.budget.scope] ?? row.budget.scope}</td>
              <td className="mono truncate">{row.budget.scope_value || "*"}</td>
              <td className="cell-number">{formatKRW(row.budget.monthly_krw)}</td>
              <td className="cell-number">{formatKRW(row.spent_krw)}</td>
              <td>
                <div className="cell-number">{formatSignedRatio(row.burn_ratio)}</div>
                <UsageMeter
                  ratio={row.burn_ratio}
                  label={`${row.budget.scope_value || "전체"} 예산 소진율`}
                />
              </td>
              <td className="cell-number">{formatKRW(row.projected_krw)}</td>
              <td>{row.exhaustion_date ? formatDate(row.exhaustion_date) : "—"}</td>
              <td>
                <div className="table-actions">
                  <Button
                    size="small"
                    variant="danger"
                    disabled={!allowed}
                    title={deniedReason}
                    onClick={(event) => {
                      rowTriggerRef.current = event.currentTarget;
                      setRemovingBudget(row);
                    }}
                  >
                    삭제
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
