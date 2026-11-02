import { useAccessOperation } from "./use-access-operation";
import { useRef, useState } from "react";
import { z } from "zod";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { withPathParams } from "@/shared/api/endpoint-factory";
import type { CreateBudgetBody, CreateQuotaBody, UpdateQuotaBody } from "@/shared/api/domains/access";
import type { BudgetStatus, QuotaUsage } from "@/shared/api/domains/access.schemas";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { type FeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { accessKeys } from "./use-access-admin";

const access = endpoints.domains.access;
const routeId = "access.users";
const nonNegativeAmount = z
  .string()
  .refine(
    (value) => Number.isFinite(Number(value)) && Number(value) >= 0,
    "0 이상의 유한한 금액을 입력하세요.",
  );
const tokenLimit = z
  .string()
  .refine(
    (value) => Number.isSafeInteger(Number(value)) && Number(value) >= 0,
    "0 이상의 안전한 정수 토큰 수를 입력하세요.",
  );
const quotaSchema = z
  .object({
    scope: z.enum(["api_key", "team", "ip", "global"]),
    scope_value: z.string(),
    period: z.enum(["daily", "monthly"]),
    token_limit: tokenLimit,
    krw_limit: nonNegativeAmount,
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
  .object({ token_limit: tokenLimit, krw_limit: nonNegativeAmount, note: z.string(), enabled: z.boolean() })
  .refine((values) => Number(values.token_limit) >= 0 && Number(values.krw_limit) >= 0, {
    message: "한도는 0 이상이어야 합니다.",
    path: ["token_limit"],
  });
type QuotaEditForm = z.infer<typeof quotaEditSchema>;

const budgetSchema = z
  .object({
    scope: z.enum(["global", "team", "api_key"]),
    scope_value: z.string(),
    monthly_krw: nonNegativeAmount,
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

export const scopeLabels: Readonly<Record<string, string>> = {
  api_key: "API 키",
  team: "팀",
  ip: "IP",
  global: "전체",
};

export function useQuotaBudgetOperations(owner: FeatureReadOwner, canWrite: boolean, reason: string) {
  const { write, assertCurrent, safety, run } = useAccessOperation(owner, canWrite, reason, "quota-budget");
  const [quotaOpen, setQuotaOpen] = useState(false);
  const [budgetOpen, setBudgetOpen] = useState(false);
  const [editingQuota, setEditingQuota] = useState<QuotaUsage | undefined>();
  const [togglingQuota, setTogglingQuota] = useState<QuotaUsage | undefined>();
  const [removingQuota, setRemovingQuota] = useState<QuotaUsage | undefined>();
  const [removingBudget, setRemovingBudget] = useState<BudgetStatus | undefined>();
  const quotaTrigger = useRef<HTMLButtonElement>(null);
  const budgetTrigger = useRef<HTMLButtonElement>(null);
  const rowTrigger = useRef<HTMLElement>(null);

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
    enabled: true,
  });
  const budgetForm = useZodForm<BudgetForm, BudgetForm>(budgetSchema, {
    scope: "team",
    scope_value: "",
    monthly_krw: "",
    note: "",
  });

  const createQuota = useMutationFeedback({
    ...safety,
    mutate: (body: CreateQuotaBody) =>
      run(() => apiClient.request(access.quotas.create, { body, routeId, retryUnauthorized: false })),
    invalidates: [accessKeys.quotas],
    successMessage: "할당량을 만들었습니다.",
  });
  const updateQuota = useMutationFeedback({
    ...safety,
    mutate: ({ id, body }: { id: string; body: UpdateQuotaBody }) =>
      run(() =>
        apiClient.request(withPathParams(access.quotas.update, { id }), {
          body,
          routeId,
          retryUnauthorized: false,
        }),
      ),
    invalidates: [accessKeys.quotas],
    successMessage: "할당량을 수정했습니다.",
  });
  const removeQuota = useMutationFeedback({
    ...safety,
    mutate: (id: string) =>
      run(() =>
        apiClient.request(withPathParams(access.quotas.remove, { id }), {
          routeId,
          retryUnauthorized: false,
        }),
      ),
    invalidates: [accessKeys.quotas],
    successMessage: "할당량을 삭제했습니다.",
  });
  const createBudget = useMutationFeedback({
    ...safety,
    mutate: (body: CreateBudgetBody) =>
      run(() => apiClient.request(access.budgets.create, { body, routeId, retryUnauthorized: false })),
    invalidates: [accessKeys.budgets],
    successMessage: "예산을 만들었습니다.",
  });
  const removeBudget = useMutationFeedback({
    ...safety,
    mutate: (id: string) =>
      run(() =>
        apiClient.request(withPathParams(access.budgets.remove, { id }), {
          routeId,
          retryUnauthorized: false,
        }),
      ),
    invalidates: [accessKeys.budgets],
    successMessage: "예산을 삭제했습니다.",
  });

  return {
    quotaOpen,
    setQuotaOpen,
    budgetOpen,
    setBudgetOpen,
    editingQuota,
    setEditingQuota,
    togglingQuota,
    setTogglingQuota,
    removingQuota,
    setRemovingQuota,
    removingBudget,
    setRemovingBudget,
    quotaTrigger,
    budgetTrigger,
    rowTrigger,
    quotaForm,
    quotaEditForm,
    budgetForm,
    createQuota,
    updateQuota,
    removeQuota,
    createBudget,
    removeBudget,
    write,
    assertCurrent,
  };
}
export type QuotaBudgetOperations = ReturnType<typeof useQuotaBudgetOperations>;
