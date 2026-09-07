import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { z } from "zod";

import { formatSignedRatio, severityTone } from "@/features/access/access-format";
import { QueryNotice, UpdatedAt, UsageMeter } from "@/features/access/access-ui";
import {
  accessKeys,
  useBudgetProjectionQuery,
  useBudgetsQuery,
  useQuotasQuery,
} from "@/features/access/users/use-access-admin";
import { apiClient } from "@/shared/api/client";
import type { CreateBudgetBody, CreateQuotaBody, UpdateQuotaBody } from "@/shared/api/domains/access";
import type { BudgetStatus, QuotaUsage } from "@/shared/api/domains/access.schemas";
import { withPathParams } from "@/shared/api/endpoint-factory";
import { endpoints } from "@/shared/api/endpoints";
import { FormDialog } from "@/shared/components/form/FormDialog";
import { FormField } from "@/shared/components/form/FormField";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { LoadingState } from "@/shared/components/state/PageStates";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { Switch } from "@/shared/components/ui/Switch";
import { Textarea } from "@/shared/components/ui/Textarea";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { formatDate, formatKRW, formatNumber } from "@/shared/utils/format";

const access = endpoints.domains.access;
const routeId = "access.users";

const quotaSchema = z
  .object({
    scope: z.enum(["api_key", "team", "ip", "global"]),
    scope_value: z.string(),
    period: z.enum(["daily", "monthly"]),
    token_limit: z.string(),
    krw_limit: z.string(),
    note: z.string(),
  })
  .refine((values) => Number(values.token_limit) > 0 || Number(values.krw_limit) > 0, {
    message: "토큰 한도와 비용 한도 중 하나는 0보다 커야 합니다.",
    path: ["token_limit"],
  })
  .refine((values) => values.scope === "global" || values.scope_value.trim() !== "", {
    message: "대상 값을 입력하세요.",
    path: ["scope_value"],
  });
type QuotaForm = z.infer<typeof quotaSchema>;

// PATCH only accepts the limits, the on/off flag and the note; scope and period
// are fixed for the life of a quota.
const quotaEditSchema = z
  .object({ token_limit: z.string(), krw_limit: z.string(), note: z.string() })
  .refine((values) => Number(values.token_limit) >= 0 && Number(values.krw_limit) >= 0, {
    message: "한도는 0 이상이어야 합니다.",
    path: ["token_limit"],
  });
type QuotaEditForm = z.infer<typeof quotaEditSchema>;

const budgetSchema = z
  .object({
    scope: z.enum(["global", "team", "api_key"]),
    scope_value: z.string(),
    monthly_krw: z.string(),
    note: z.string(),
  })
  .refine((values) => Number(values.monthly_krw) > 0, {
    message: "월 예산은 0보다 커야 합니다.",
    path: ["monthly_krw"],
  })
  .refine((values) => values.scope === "global" || values.scope_value.trim() !== "", {
    message: "대상 값을 입력하세요.",
    path: ["scope_value"],
  });
type BudgetForm = z.infer<typeof budgetSchema>;

const scopeLabels: Readonly<Record<string, string>> = {
  api_key: "API 키",
  team: "팀",
  ip: "IP",
  global: "전체",
};

function usedRatio(remainRatio: number): number {
  return remainRatio < 0 ? 0 : Math.min(Math.max(1 - remainRatio, 0), 1);
}

interface QuotasTabProps {
  canWrite: boolean;
  writeDeniedReason: string;
}

export function QuotasTab({ canWrite, writeDeniedReason }: QuotasTabProps): React.JSX.Element {
  const quotas = useQuotasQuery(true);
  const budgets = useBudgetsQuery(true);
  const projection = useBudgetProjectionQuery(true);
  const [alertsRequested, setAlertsRequested] = useState(false);
  const [quotaOpen, setQuotaOpen] = useState(false);
  const [budgetOpen, setBudgetOpen] = useState(false);
  const [editingQuota, setEditingQuota] = useState<QuotaUsage | undefined>();
  const [editEnabled, setEditEnabled] = useState(true);
  const [togglingQuota, setTogglingQuota] = useState<QuotaUsage | undefined>();
  const [removingQuota, setRemovingQuota] = useState<QuotaUsage | undefined>();
  const [removingBudget, setRemovingBudget] = useState<BudgetStatus | undefined>();
  const [notifying, setNotifying] = useState(false);
  const quotaTrigger = useRef<HTMLButtonElement>(null);
  const budgetTrigger = useRef<HTMLButtonElement>(null);
  const rowTrigger = useRef<HTMLElement>(null);
  const notifyTrigger = useRef<HTMLButtonElement>(null);

  const alerts = useQuery({
    queryKey: [...accessKeys.budgetAlerts, "check"],
    enabled: alertsRequested,
    queryFn: ({ signal }) => apiClient.request(access.budgets.alerts, { query: { all: 1 }, signal, routeId }),
  });

  const quotaForm = useZodForm<QuotaForm, QuotaForm>(quotaSchema, {
    scope: "team",
    scope_value: "",
    period: "monthly",
    token_limit: "",
    krw_limit: "",
    note: "",
  });
  const quotaEditForm = useZodForm<QuotaEditForm, QuotaEditForm>(quotaEditSchema, {
    token_limit: "",
    krw_limit: "",
    note: "",
  });
  const budgetForm = useZodForm<BudgetForm, BudgetForm>(budgetSchema, {
    scope: "team",
    scope_value: "",
    monthly_krw: "",
    note: "",
  });

  const createQuota = useMutationFeedback({
    mutate: (body: CreateQuotaBody) => apiClient.request(access.quotas.create, { body, routeId }),
    invalidates: [accessKeys.quotas],
    successMessage: "할당량을 만들었습니다.",
  });
  const updateQuota = useMutationFeedback({
    mutate: ({ id, body }: { id: string; body: UpdateQuotaBody }) =>
      apiClient.request(withPathParams(access.quotas.update, { id }), { body, routeId }),
    invalidates: [accessKeys.quotas],
    successMessage: "할당량을 수정했습니다.",
  });
  const removeQuota = useMutationFeedback({
    mutate: (id: string) => apiClient.request(withPathParams(access.quotas.remove, { id }), { routeId }),
    invalidates: [accessKeys.quotas],
    successMessage: "할당량을 삭제했습니다.",
  });
  const createBudget = useMutationFeedback({
    mutate: (body: CreateBudgetBody) => apiClient.request(access.budgets.create, { body, routeId }),
    invalidates: [accessKeys.budgets],
    successMessage: "예산을 만들었습니다.",
  });
  const removeBudget = useMutationFeedback({
    mutate: (id: string) => apiClient.request(withPathParams(access.budgets.remove, { id }), { routeId }),
    invalidates: [accessKeys.budgets],
    successMessage: "예산을 삭제했습니다.",
  });
  const sendAlerts = useMutationFeedback({
    mutate: () => apiClient.request(access.budgets.alerts, { query: { all: 1, notify: 1 }, routeId }),
    successMessage: (result) => `예산 경보 ${formatNumber(result.alerts.length)}건을 발송했습니다.`,
  });

  if (quotas.isPending && !quotas.data) {
    return <LoadingState label="할당량과 예산을 불러오는 중입니다." />;
  }

  const usage = quotas.data?.usage ?? [];
  const budgetRows = budgets.data?.budgets ?? [];
  const projectionRows = projection.data?.teams ?? [];
  const overBudget = budgetRows.filter((row) => !row.on_track).length;

  return (
    <div className="access-stack">
      {quotas.isError ? (
        <QueryNotice
          error={quotas.error}
          hasData={Boolean(quotas.data)}
          label="할당량"
          onRetry={() => void quotas.refetch()}
        />
      ) : null}
      {budgets.isError ? (
        <QueryNotice
          error={budgets.error}
          hasData={Boolean(budgets.data)}
          label="예산"
          onRetry={() => void budgets.refetch()}
        />
      ) : null}

      <StatGrid label="할당량과 예산 요약">
        <StatCard label="할당량" value={formatNumber(usage.length)} />
        <StatCard
          label="사용 중지된 할당량"
          value={formatNumber(usage.filter((row) => !row.quota.enabled).length)}
        />
        <StatCard label="예산" value={formatNumber(budgetRows.length)} />
        <StatCard
          label="예상 초과 예산"
          tone={overBudget > 0 ? "danger" : "default"}
          value={formatNumber(overBudget)}
        />
      </StatGrid>

      <SectionCard
        title="할당량"
        description="범위별 토큰·비용 한도와 현재 사용량입니다. 한도가 설정되지 않은 항목은 대시로 표시합니다."
        actions={
          <Button
            ref={quotaTrigger}
            variant="primary"
            disabled={!canWrite}
            title={canWrite ? undefined : writeDeniedReason}
            onClick={() => {
              quotaForm.reset({
                scope: "team",
                scope_value: "",
                period: "monthly",
                token_limit: "",
                krw_limit: "",
                note: "",
              });
              setQuotaOpen(true);
            }}
          >
            할당량 추가
          </Button>
        }
      >
        {!canWrite ? <InlineNotice tone="info">{writeDeniedReason}</InlineNotice> : null}
        {usage.length === 0 ? (
          <EmptyState
            title="설정된 할당량이 없습니다."
            description="'할당량 추가'로 팀이나 키의 토큰·비용 한도를 정하면 사용량이 여기에 표시됩니다."
          />
        ) : (
          <div className="data-table-scroll" tabIndex={0} aria-label="할당량 표 영역">
            <table className="data-table">
              <caption className="sr-only">할당량과 사용량</caption>
              <thead>
                <tr>
                  <th scope="col">범위</th>
                  <th scope="col">대상</th>
                  <th scope="col">주기</th>
                  <th scope="col">상태</th>
                  <th scope="col">토큰</th>
                  <th scope="col">비용</th>
                  <th scope="col">기간</th>
                  <th scope="col">작업</th>
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
                          disabled={!canWrite}
                          title={canWrite ? undefined : writeDeniedReason}
                          onClick={(event) => {
                            rowTrigger.current = event.currentTarget;
                            quotaEditForm.reset({
                              token_limit: row.quota.token_limit > 0 ? String(row.quota.token_limit) : "",
                              krw_limit: row.quota.krw_limit > 0 ? String(row.quota.krw_limit) : "",
                              note: row.quota.note,
                            });
                            setEditEnabled(row.quota.enabled);
                            setEditingQuota(row);
                          }}
                        >
                          수정
                        </Button>
                        <Button
                          size="small"
                          variant="secondary"
                          disabled={!canWrite}
                          title={canWrite ? undefined : writeDeniedReason}
                          onClick={(event) => {
                            rowTrigger.current = event.currentTarget;
                            setTogglingQuota(row);
                          }}
                        >
                          {row.quota.enabled ? "중지" : "사용"}
                        </Button>
                        <Button
                          size="small"
                          variant="danger"
                          disabled={!canWrite}
                          title={canWrite ? undefined : writeDeniedReason}
                          onClick={(event) => {
                            rowTrigger.current = event.currentTarget;
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
        )}
        <UpdatedAt at={quotas.dataUpdatedAt} />
      </SectionCard>

      <SectionCard
        title="월 예산"
        description="월 예산 대비 소진율과 이번 달 예상 지출입니다."
        actions={
          <Button
            ref={budgetTrigger}
            variant="primary"
            disabled={!canWrite}
            title={canWrite ? undefined : writeDeniedReason}
            onClick={() => {
              budgetForm.reset({ scope: "team", scope_value: "", monthly_krw: "", note: "" });
              setBudgetOpen(true);
            }}
          >
            예산 추가
          </Button>
        }
      >
        {budgetRows.length === 0 ? (
          <EmptyState
            title="설정된 예산이 없습니다."
            description="'예산 추가'로 팀이나 키의 월 예산을 정하면 소진율과 예상 지출이 표시됩니다."
          />
        ) : (
          <div className="data-table-scroll" tabIndex={0} aria-label="월 예산 표 영역">
            <table className="data-table">
              <caption className="sr-only">월 예산 소진 현황</caption>
              <thead>
                <tr>
                  <th scope="col">범위</th>
                  <th scope="col">대상</th>
                  <th scope="col">월 예산</th>
                  <th scope="col">사용</th>
                  <th scope="col">소진율</th>
                  <th scope="col">예상 지출</th>
                  <th scope="col">소진 예상일</th>
                  <th scope="col">작업</th>
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
                          disabled={!canWrite}
                          title={canWrite ? undefined : writeDeniedReason}
                          onClick={(event) => {
                            rowTrigger.current = event.currentTarget;
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
        )}
        <UpdatedAt at={budgets.dataUpdatedAt} />
      </SectionCard>

      <SectionCard
        title="팀별 월말 예상 지출"
        description="이번 달 사용 속도로 계산한 팀별 월말 예상 지출과 팀 예산 초과 여부입니다."
      >
        {projection.isError ? (
          <QueryNotice
            error={projection.error}
            hasData={Boolean(projection.data)}
            label="지출 예측"
            onRetry={() => void projection.refetch()}
          />
        ) : null}
        {projectionRows.length === 0 ? (
          <EmptyState
            title="예측할 팀 사용량이 없습니다."
            description="이번 달에 요청을 보낸 팀이 생기면 월말 예상 지출을 계산합니다."
          />
        ) : (
          <div className="data-table-scroll" tabIndex={0} aria-label="팀별 월말 예상 지출 표 영역">
            <table className="data-table">
              <caption className="sr-only">팀별 월말 예상 지출</caption>
              <thead>
                <tr>
                  <th scope="col">팀</th>
                  <th scope="col">이번 달 지출</th>
                  <th scope="col">월말 예상</th>
                  <th scope="col">팀 예산</th>
                  <th scope="col">예상 초과액</th>
                  <th scope="col">경과일</th>
                </tr>
              </thead>
              <tbody>
                {projectionRows.map((row) => (
                  <tr key={row.team} className={row.will_exceed ? "row-danger" : undefined}>
                    <td className="truncate">
                      {row.team || "—"}
                      {row.will_exceed ? <Badge tone="danger">초과 예상</Badge> : null}
                    </td>
                    <td className="cell-number">{formatKRW(row.spent_krw)}</td>
                    <td className="cell-number">{formatKRW(row.projected_krw)}</td>
                    <td className="cell-number">{row.has_budget ? formatKRW(row.budget_krw) : "미설정"}</td>
                    <td className="cell-number">
                      {row.projected_overage_krw > 0 ? formatKRW(row.projected_overage_krw) : "—"}
                    </td>
                    <td className="cell-number">
                      {formatNumber(row.days_elapsed, 1)} / {formatNumber(row.days_in_month, 1)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="access-note">
          예상 초과 팀 {formatNumber(projection.data?.exceeding ?? 0)}곳입니다. 팀 예산이 없는 팀은 초과
          여부를 계산하지 않습니다.
        </p>
        <UpdatedAt at={projection.dataUpdatedAt} />
      </SectionCard>

      <SectionCard
        title="예산 경보"
        description="경보를 확인해도 알림은 발송되지 않습니다. 발송은 별도 버튼으로만 실행합니다."
        actions={
          <div className="access-inline-actions">
            <Button onClick={() => setAlertsRequested(true)} disabled={alerts.isFetching}>
              {alerts.isFetching ? "확인 중" : "경보 확인"}
            </Button>
            <Button
              ref={notifyTrigger}
              variant="secondary"
              disabled={!canWrite}
              title={canWrite ? undefined : writeDeniedReason}
              onClick={() => setNotifying(true)}
            >
              경보 발송
            </Button>
          </div>
        }
      >
        {!alertsRequested ? (
          <p className="access-note">
            '경보 확인'을 누르면 현재 예산 경보 목록을 조회합니다. 조회만으로는 알림이 나가지 않습니다.
          </p>
        ) : alerts.isError ? (
          <QueryNotice
            error={alerts.error}
            hasData={Boolean(alerts.data)}
            label="예산 경보"
            onRetry={() => void alerts.refetch()}
          />
        ) : alerts.data && alerts.data.alerts.length === 0 ? (
          <EmptyState
            title="경보가 없습니다."
            description="설정된 예산이 임계값을 넘으면 이 목록에 나타납니다."
          />
        ) : alerts.data ? (
          <ul className="access-list">
            {alerts.data.alerts.map((row, index) => (
              <li key={`${row.scope}-${row.scope_value}-${String(index)}`}>
                <span className="access-list-title">
                  <Badge tone={severityTone(row.severity)}>{row.severity || "정보"}</Badge>
                  {scopeLabels[row.scope] ?? row.scope} · {row.scope_value || "*"}
                </span>
                <span className="access-list-detail">
                  {formatKRW(row.spent_krw)} / {formatKRW(row.monthly_krw)} · 소진율{" "}
                  {formatSignedRatio(row.burn_ratio)} · 예상 {formatKRW(row.projected_krw)}
                  {row.exhaustion_date ? ` · 소진 예상 ${formatDate(row.exhaustion_date)}` : ""}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </SectionCard>

      <FormDialog
        form={quotaForm}
        open={quotaOpen}
        onOpenChange={setQuotaOpen}
        returnFocusRef={quotaTrigger}
        title="할당량 추가"
        description="범위와 주기를 정하고 토큰 또는 비용 한도를 하나 이상 입력합니다."
        onSubmit={async (values) => {
          const tokenLimit = Number(values.token_limit);
          const krwLimit = Number(values.krw_limit);
          await createQuota.mutateAsync({
            scope: values.scope,
            scope_value: values.scope === "global" ? "*" : values.scope_value.trim(),
            period: values.period,
            ...(tokenLimit > 0 ? { token_limit: tokenLimit } : {}),
            ...(krwLimit > 0 ? { krw_limit: krwLimit } : {}),
            enabled: true,
            ...(values.note ? { note: values.note } : {}),
          });
          setQuotaOpen(false);
        }}
      >
        <FormField label="범위">
          {(control) => (
            <Select {...control} {...quotaForm.register("scope")}>
              <option value="api_key">API 키</option>
              <option value="team">팀</option>
              <option value="ip">IP</option>
              <option value="global">전체</option>
            </Select>
          )}
        </FormField>
        <FormField
          label="대상"
          description="키 ID, 팀 이름 또는 IP. 전체 범위에서는 자동으로 *가 됩니다."
          error={quotaForm.formState.errors.scope_value?.message}
        >
          {(control) => <Input {...control} {...quotaForm.register("scope_value")} />}
        </FormField>
        <FormField label="주기">
          {(control) => (
            <Select {...control} {...quotaForm.register("period")}>
              <option value="daily">일별</option>
              <option value="monthly">월별</option>
            </Select>
          )}
        </FormField>
        <FormField label="토큰 한도" error={quotaForm.formState.errors.token_limit?.message}>
          {(control) => <Input {...control} type="number" min={0} {...quotaForm.register("token_limit")} />}
        </FormField>
        <FormField label="비용 한도(원)">
          {(control) => <Input {...control} type="number" min={0} {...quotaForm.register("krw_limit")} />}
        </FormField>
        <FormField label="메모">
          {(control) => <Textarea {...control} rows={2} {...quotaForm.register("note")} />}
        </FormField>
      </FormDialog>

      <FormDialog
        form={budgetForm}
        open={budgetOpen}
        onOpenChange={setBudgetOpen}
        returnFocusRef={budgetTrigger}
        title="예산 추가"
        description="월 예산을 정하면 소진율과 이번 달 예상 지출을 추적합니다."
        onSubmit={async (values) => {
          await createBudget.mutateAsync({
            scope: values.scope,
            scope_value: values.scope === "global" ? "*" : values.scope_value.trim(),
            monthly_krw: Number(values.monthly_krw),
            ...(values.note ? { note: values.note } : {}),
          });
          setBudgetOpen(false);
        }}
      >
        <FormField label="범위" description="예산은 IP 범위를 지원하지 않습니다.">
          {(control) => (
            <Select {...control} {...budgetForm.register("scope")}>
              <option value="global">전체</option>
              <option value="team">팀</option>
              <option value="api_key">API 키</option>
            </Select>
          )}
        </FormField>
        <FormField label="대상" error={budgetForm.formState.errors.scope_value?.message}>
          {(control) => <Input {...control} {...budgetForm.register("scope_value")} />}
        </FormField>
        <FormField label="월 예산(원)" required error={budgetForm.formState.errors.monthly_krw?.message}>
          {(control) => <Input {...control} type="number" min={1} {...budgetForm.register("monthly_krw")} />}
        </FormField>
        <FormField label="메모">
          {(control) => <Textarea {...control} rows={2} {...budgetForm.register("note")} />}
        </FormField>
      </FormDialog>

      <FormDialog
        form={quotaEditForm}
        open={editingQuota !== undefined}
        onOpenChange={(open) => {
          if (!open) setEditingQuota(undefined);
        }}
        returnFocusRef={rowTrigger}
        title="할당량 수정"
        description="한도와 메모, 사용 여부만 바꿀 수 있습니다. 범위와 주기는 만들 때 정해집니다."
        onSubmit={async (values) => {
          if (!editingQuota) return;
          await updateQuota.mutateAsync({
            id: editingQuota.quota.id,
            body: {
              token_limit: Number(values.token_limit) || 0,
              krw_limit: Number(values.krw_limit) || 0,
              enabled: editEnabled,
              note: values.note,
            },
          });
          setEditingQuota(undefined);
        }}
      >
        <FormField label="범위와 대상">
          {(control) => (
            <Input
              {...control}
              readOnly
              value={`${scopeLabels[editingQuota?.quota.scope ?? ""] ?? editingQuota?.quota.scope ?? ""} · ${editingQuota?.quota.scope_value || "*"}`}
            />
          )}
        </FormField>
        <FormField
          label="토큰 한도"
          description="0을 넣으면 토큰 한도를 없앱니다."
          error={quotaEditForm.formState.errors.token_limit?.message}
        >
          {(control) => (
            <Input {...control} type="number" min={0} {...quotaEditForm.register("token_limit")} />
          )}
        </FormField>
        <FormField label="비용 한도(원)" description="0을 넣으면 비용 한도를 없앱니다.">
          {(control) => <Input {...control} type="number" min={0} {...quotaEditForm.register("krw_limit")} />}
        </FormField>
        <FormField label="메모">
          {(control) => <Textarea {...control} rows={2} {...quotaEditForm.register("note")} />}
        </FormField>
        <Switch
          checked={editEnabled}
          onCheckedChange={setEditEnabled}
          label={editEnabled ? "사용 중" : "중지됨"}
        />
      </FormDialog>

      <ConfirmDialog
        open={togglingQuota !== undefined}
        onOpenChange={(open) => {
          if (!open) setTogglingQuota(undefined);
        }}
        returnFocusRef={rowTrigger}
        tone={togglingQuota?.quota.enabled ? "danger" : "primary"}
        title={togglingQuota?.quota.enabled ? "할당량 중지" : "할당량 사용"}
        description={
          togglingQuota?.quota.enabled
            ? `${togglingQuota.quota.scope_value || "*"} 대상 할당량을 중지합니다. 중지하는 동안 이 범위에는 한도가 적용되지 않습니다.`
            : `${togglingQuota?.quota.scope_value || "*"} 대상 할당량을 다시 적용합니다.`
        }
        confirmLabel={togglingQuota?.quota.enabled ? "중지" : "사용"}
        onConfirm={async () => {
          if (togglingQuota) {
            await updateQuota.mutateAsync({
              id: togglingQuota.quota.id,
              body: { enabled: !togglingQuota.quota.enabled },
            });
          }
          setTogglingQuota(undefined);
        }}
      />

      <ConfirmDialog
        open={removingQuota !== undefined}
        onOpenChange={(open) => {
          if (!open) setRemovingQuota(undefined);
        }}
        returnFocusRef={rowTrigger}
        tone="danger"
        title="할당량 삭제"
        description={`${removingQuota?.quota.scope_value || "*"} 대상 할당량을 삭제합니다. 이후 해당 범위에는 한도가 적용되지 않습니다.`}
        confirmLabel="삭제"
        onConfirm={async () => {
          if (removingQuota) await removeQuota.mutateAsync(removingQuota.quota.id);
          setRemovingQuota(undefined);
        }}
      />

      <ConfirmDialog
        open={removingBudget !== undefined}
        onOpenChange={(open) => {
          if (!open) setRemovingBudget(undefined);
        }}
        returnFocusRef={rowTrigger}
        tone="danger"
        title="예산 삭제"
        description={`${removingBudget?.budget.scope_value || "*"} 대상 예산을 삭제합니다. 소진율 추적과 경보가 중단됩니다.`}
        confirmLabel="삭제"
        onConfirm={async () => {
          if (removingBudget) await removeBudget.mutateAsync(removingBudget.budget.id);
          setRemovingBudget(undefined);
        }}
      />

      <ConfirmDialog
        open={notifying}
        onOpenChange={setNotifying}
        returnFocusRef={notifyTrigger}
        title="예산 경보 발송"
        description="현재 임계값을 넘은 예산 경보를 Mattermost로 발송합니다. 실제 알림이 나가므로 확인 후 진행하세요."
        confirmLabel="발송"
        onConfirm={async () => {
          await sendAlerts.mutateAsync(undefined);
          setNotifying(false);
        }}
      />
    </div>
  );
}
