import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { z } from "zod";

import { formatSignedRatio, severityTone } from "@/features/access/access-format";
import { QueryNotice, UpdatedAt, UsageMeter } from "@/features/access/access-ui";
import { accessKeys, useBudgetsQuery, useQuotasQuery } from "@/features/access/users/use-access-admin";
import { apiClient } from "@/shared/api/client";
import { withPathParams, type CreateBudgetBody, type CreateQuotaBody } from "@/shared/api/domains/access";
import type { BudgetStatus, QuotaUsage } from "@/shared/api/domains/access.schemas";
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
  const [alertsRequested, setAlertsRequested] = useState(false);
  const [quotaOpen, setQuotaOpen] = useState(false);
  const [budgetOpen, setBudgetOpen] = useState(false);
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

      <InlineNotice tone="info" title="할당량은 만들고 지울 수만 있습니다.">
        서버가 이 UI 버전에 할당량 수정(사용/중지 전환, 한도 변경) API를 노출하지 않습니다. 한도를 바꾸려면
        기존 할당량을 삭제하고 새로 만드세요.
      </InlineNotice>

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
