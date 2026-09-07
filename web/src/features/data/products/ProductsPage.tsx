import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, RefreshCw } from "lucide-react";
import { useRef, useState } from "react";

import "@/features/data/data.css";

import { DataQueryNotice } from "@/features/data/DataQueryNotice";
import { SimpleTable } from "@/features/data/SimpleTable";
import {
  candidateWindowLabels,
  candidateWindows,
  emptyProductForm,
  parseTeams,
  productFormSchema,
  productSensitivities,
  productSensitivityLabels,
  productSourceTypeLabels,
  productSourceTypes,
  productStatusLabels,
  productStatuses,
  productTabs,
  requestStatusLabels,
  type ProductFormValues,
  type ProductTab,
} from "@/features/data/products/product-fields";
import { oneOf, positiveInt } from "@/features/data/warehouse/warehouse-filters";
import { useAuth } from "@/app/auth/AuthProvider";
import { apiClient } from "@/shared/api/client";
import type {
  DataProduct,
  DataProductCandidate,
  DataProductRequest,
} from "@/shared/api/domains/data.schemas";
import { endpoints } from "@/shared/api/endpoints";
import { FormDialog } from "@/shared/components/form/FormDialog";
import { FormField } from "@/shared/components/form/FormField";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { PageHeader } from "@/shared/components/page/PageHeader";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { TabPanel, Tabs } from "@/shared/components/ui/Tabs";
import { Textarea } from "@/shared/components/ui/Textarea";
import { Toolbar } from "@/shared/components/ui/Toolbar";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { useRefreshInterval } from "@/shared/hooks/use-refresh-interval";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { useTabParam } from "@/shared/hooks/use-tab-param";
import { formatDateTime, formatNumber } from "@/shared/utils/format";

const products = endpoints.domains.data.products;
const productQueryKey = ["data", "products"] as const;
const maxMinCount = 100;

const tabLabels: Record<ProductTab, string> = {
  catalog: "데이터 상품",
  requests: "접근 요청",
  candidates: "발행 후보",
};

const writeDeniedReason = "admin:write 권한이 필요합니다.";

type PendingAction =
  | { kind: "publish"; product: DataProduct; status: "published" | "archived" }
  | { kind: "delete"; product: DataProduct }
  | { kind: "decide"; request: DataProductRequest; action: "approve" | "deny" };

export function ProductsPage(): React.JSX.Element {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const refetchInterval = useRefreshInterval();
  const [tab, setTab] = useTabParam<ProductTab>(productTabs);
  const [params, update] = useSearchState();
  const canWrite = auth.user?.scopes.includes("admin:write") ?? false;

  const status = params.get("status") ?? "";
  const productFilter = params.get("product") ?? "";
  const candidateWindow = oneOf(params.get("window"), candidateWindows, "30d");
  const minCount = positiveInt(params.get("min_count"), 3, maxMinCount);

  const [formOpen, setFormOpen] = useState(false);
  const [pending, setPending] = useState<PendingAction | undefined>();
  const createTriggerRef = useRef<HTMLButtonElement>(null);
  const actionTriggerRef = useRef<HTMLElement>(null);
  const form = useZodForm(productFormSchema, emptyProductForm);

  const catalog = useQuery({
    queryKey: [...productQueryKey, "catalog", status],
    queryFn: ({ signal }) => apiClient.request(products.list, { query: status ? { status } : {}, signal }),
    refetchInterval,
  });
  const requests = useQuery({
    queryKey: [...productQueryKey, "requests", productFilter],
    queryFn: ({ signal }) =>
      apiClient.request(products.requests, {
        query: productFilter ? { product: productFilter } : {},
        signal,
      }),
    enabled: tab === "requests",
    refetchInterval,
  });
  const candidates = useQuery({
    queryKey: [...productQueryKey, "candidates", candidateWindow, minCount],
    queryFn: ({ signal }) =>
      apiClient.request(products.candidates, {
        query: { window: candidateWindow, min_count: minCount },
        signal,
      }),
    enabled: tab === "candidates",
    refetchInterval,
  });

  const upsert = useMutationFeedback({
    mutate: (values: ProductFormValues) =>
      apiClient.request(products.upsert, {
        body: {
          ...(values.id ? { id: values.id } : {}),
          product_key: values.product_key,
          name_ko: values.name_ko,
          description: values.description,
          source_type: values.source_type,
          source_ref: values.source_ref,
          owner: values.owner,
          allowed_teams: parseTeams(values.allowed_teams),
          sensitivity: values.sensitivity,
          status: values.status,
        },
      }),
    invalidates: [productQueryKey],
    successMessage: (_result, values) => `데이터 상품 ${values.product_key}을(를) 저장했습니다.`,
    errorMessage: "데이터 상품을 저장하지 못했습니다.",
  });

  const changeStatus = useMutationFeedback({
    mutate: (input: { product: DataProduct; status: string }) =>
      apiClient.request(products.upsert, {
        body: {
          id: input.product.id,
          product_key: input.product.product_key,
          name_ko: input.product.name_ko,
          description: input.product.description,
          source_type: input.product.source_type || "custom",
          source_ref: input.product.source_ref,
          owner: input.product.owner,
          allowed_teams: input.product.allowed_teams,
          sensitivity: input.product.sensitivity,
          status: input.status,
        },
      }),
    invalidates: [productQueryKey],
    successMessage: (_result, input) =>
      `${input.product.product_key} 상태를 ${productStatusLabels[input.status] ?? input.status}(으)로 변경했습니다.`,
    errorMessage: "상태를 변경하지 못했습니다.",
  });

  const remove = useMutationFeedback({
    mutate: (product: DataProduct) => apiClient.request(products.remove, { query: { id: product.id } }),
    invalidates: [productQueryKey],
    successMessage: (_result, product) => `${product.product_key}을(를) 삭제했습니다.`,
    errorMessage: "데이터 상품을 삭제하지 못했습니다.",
  });

  const decide = useMutationFeedback({
    mutate: (input: { id: string; action: "approve" | "deny" }) =>
      apiClient.request(products.decide, { body: { id: input.id, action: input.action } }),
    invalidates: [productQueryKey],
    successMessage: (_result, input) =>
      input.action === "approve" ? "접근 요청을 승인했습니다." : "접근 요청을 거절했습니다.",
    errorMessage: "접근 요청을 처리하지 못했습니다.",
  });

  const openCreate = (preset?: Partial<ProductFormValues>): void => {
    form.reset({ ...emptyProductForm, ...preset });
    setFormOpen(true);
  };
  const openEdit = (product: DataProduct, trigger: HTMLElement): void => {
    actionTriggerRef.current = trigger;
    form.reset({
      id: product.id,
      product_key: product.product_key,
      name_ko: product.name_ko,
      description: product.description,
      source_type: oneOf(product.source_type, productSourceTypes, "custom"),
      source_ref: product.source_ref,
      owner: product.owner,
      allowed_teams: product.allowed_teams.join(", "),
      sensitivity: oneOf(product.sensitivity, productSensitivities, "internal"),
      status: oneOf(product.status, productStatuses, "draft"),
    });
    setFormOpen(true);
  };

  const confirmPending = async (): Promise<void> => {
    if (!pending) return;
    if (pending.kind === "publish") {
      await changeStatus.mutateAsync({ product: pending.product, status: pending.status });
    } else if (pending.kind === "delete") {
      await remove.mutateAsync(pending.product);
    } else {
      await decide.mutateAsync({ id: pending.request.id, action: pending.action });
    }
  };

  const pendingCopy = (): { title: string; description: string; label: string; danger: boolean } => {
    if (pending?.kind === "delete") {
      return {
        title: "데이터 상품 삭제",
        description: `${pending.product.product_key}을(를) 삭제합니다. 되돌릴 수 없습니다.`,
        label: "삭제",
        danger: true,
      };
    }
    if (pending?.kind === "publish") {
      const next = productStatusLabels[pending.status] ?? pending.status;
      return {
        title: pending.status === "published" ? "데이터 상품 게시" : "데이터 상품 보관",
        description: `${pending.product.product_key}의 상태를 ${next}(으)로 변경합니다.`,
        label: pending.status === "published" ? "게시" : "보관",
        danger: false,
      };
    }
    if (pending?.kind === "decide") {
      return {
        title: pending.action === "approve" ? "접근 요청 승인" : "접근 요청 거절",
        description: `${pending.request.product_key} 상품에 대한 ${pending.request.user_id || "사용자"}의 요청을 처리합니다.`,
        label: pending.action === "approve" ? "승인" : "거절",
        danger: pending.action === "deny",
      };
    }
    return { title: "", description: "", label: "확인", danger: false };
  };
  const copy = pendingCopy();

  return (
    <div className="page-stack">
      <PageHeader
        title="데이터 상품"
        description="게시된 데이터 상품과 팀의 접근 요청을 관리하고, 반복 질문을 새 상품 후보로 확인합니다."
        legacyHref="/admin#/data-products"
        actions={
          <>
            <Button
              ref={createTriggerRef}
              variant="primary"
              disabled={!canWrite}
              title={canWrite ? undefined : writeDeniedReason}
              onClick={() => {
                actionTriggerRef.current = createTriggerRef.current;
                openCreate();
              }}
            >
              <Plus aria-hidden="true" /> 상품 등록
            </Button>
            <Button
              variant="secondary"
              onClick={() => void queryClient.invalidateQueries({ queryKey: productQueryKey })}
            >
              <RefreshCw aria-hidden="true" /> 새로고침
            </Button>
          </>
        }
      />

      <Tabs
        ariaLabel="데이터 상품 화면"
        items={productTabs.map((id) => ({ id, label: tabLabels[id] }))}
        onChange={setTab}
        panelIdPrefix="products"
        value={tab}
      />

      {!canWrite ? (
        <InlineNotice tone="info" title="읽기 전용으로 열려 있습니다.">
          등록, 게시, 삭제, 요청 승인은 {writeDeniedReason}
        </InlineNotice>
      ) : null}

      {tab === "catalog" ? (
        <TabPanel id="catalog" panelIdPrefix="products">
          <SectionCard title="데이터 상품 목록" description="팀에 공개할 분석 산출물의 카탈로그입니다.">
            <Toolbar label="데이터 상품 필터">
              <label className="data-filter" htmlFor="dp-status">
                <span>상태</span>
                <Select
                  id="dp-status"
                  value={status}
                  onChange={(event) => update({ status: event.target.value || undefined })}
                >
                  <option value="">전체</option>
                  {productStatuses.map((item) => (
                    <option key={item} value={item}>
                      {productStatusLabels[item]}
                    </option>
                  ))}
                </Select>
              </label>
            </Toolbar>
            {catalog.isError ? (
              <DataQueryNotice
                error={catalog.error}
                hasPreviousData={Boolean(catalog.data)}
                label="데이터 상품"
                onRetry={() => void catalog.refetch()}
              />
            ) : null}
            <SimpleTable<DataProduct>
              caption="등록된 데이터 상품"
              loading={catalog.isPending}
              rows={catalog.data?.products ?? []}
              emptyMessage="등록된 데이터 상품이 없습니다. ‘상품 등록’으로 첫 상품을 만드세요."
              columns={[
                {
                  id: "key",
                  header: "상품 키",
                  cell: (row) => <span className="mono">{row.product_key}</span>,
                },
                { id: "name", header: "이름", cell: (row) => row.name_ko || "—" },
                {
                  id: "source",
                  header: "원천",
                  cell: (row) =>
                    `${productSourceTypeLabels[row.source_type] ?? (row.source_type || "—")}${row.source_ref ? ` · ${row.source_ref}` : ""}`,
                },
                { id: "owner", header: "담당자", cell: (row) => row.owner || "—" },
                {
                  id: "teams",
                  header: "공개 대상",
                  cell: (row) => (row.allowed_teams.length > 0 ? row.allowed_teams.join(", ") : "전체 팀"),
                },
                {
                  id: "sensitivity",
                  header: "민감도",
                  cell: (row) => (
                    <Badge tone={row.sensitivity === "restricted" ? "warning" : "muted"}>
                      {productSensitivityLabels[row.sensitivity] ?? row.sensitivity ?? "—"}
                    </Badge>
                  ),
                },
                {
                  id: "status",
                  header: "상태",
                  cell: (row) => (
                    <Badge
                      tone={
                        row.status === "published" ? "success" : row.status === "archived" ? "muted" : "info"
                      }
                    >
                      {productStatusLabels[row.status] ?? row.status ?? "—"}
                    </Badge>
                  ),
                },
                { id: "updated", header: "수정 시각", cell: (row) => formatDateTime(row.updated_at) },
                {
                  id: "actions",
                  header: "작업",
                  cell: (row) => (
                    <div className="data-inline-actions">
                      <Button
                        size="small"
                        variant="ghost"
                        disabled={!canWrite}
                        title={canWrite ? undefined : writeDeniedReason}
                        aria-label={`${row.product_key} 수정`}
                        onClick={(event) => openEdit(row, event.currentTarget)}
                      >
                        수정
                      </Button>
                      <Button
                        size="small"
                        variant="ghost"
                        disabled={!canWrite}
                        title={canWrite ? undefined : writeDeniedReason}
                        aria-label={
                          row.status === "published" ? `${row.product_key} 보관` : `${row.product_key} 게시`
                        }
                        onClick={(event) => {
                          actionTriggerRef.current = event.currentTarget;
                          setPending({
                            kind: "publish",
                            product: row,
                            status: row.status === "published" ? "archived" : "published",
                          });
                        }}
                      >
                        {row.status === "published" ? "보관" : "게시"}
                      </Button>
                      <Button
                        size="small"
                        variant="ghost"
                        disabled={!canWrite}
                        title={canWrite ? undefined : writeDeniedReason}
                        aria-label={`${row.product_key} 삭제`}
                        onClick={(event) => {
                          actionTriggerRef.current = event.currentTarget;
                          setPending({ kind: "delete", product: row });
                        }}
                      >
                        삭제
                      </Button>
                    </div>
                  ),
                },
              ]}
            />
          </SectionCard>
        </TabPanel>
      ) : null}

      {tab === "requests" ? (
        <TabPanel id="requests" panelIdPrefix="products">
          <SectionCard
            title="접근 요청"
            description="팀원이 요청한 데이터 상품 접근을 승인하거나 거절합니다."
          >
            <Toolbar label="접근 요청 필터">
              <label className="data-filter" htmlFor="dp-product">
                <span>상품</span>
                <Select
                  id="dp-product"
                  value={productFilter}
                  onChange={(event) => update({ product: event.target.value || undefined })}
                >
                  <option value="">전체 상품</option>
                  {(catalog.data?.products ?? []).map((product) => (
                    <option key={product.product_key} value={product.product_key}>
                      {product.product_key}
                    </option>
                  ))}
                </Select>
              </label>
            </Toolbar>
            {requests.isError ? (
              <DataQueryNotice
                error={requests.error}
                hasPreviousData={Boolean(requests.data)}
                label="접근 요청"
                onRetry={() => void requests.refetch()}
              />
            ) : null}
            <SimpleTable<DataProductRequest>
              caption="데이터 상품 접근 요청"
              loading={requests.isPending}
              rows={requests.data?.requests ?? []}
              emptyMessage="접근 요청이 없습니다. 팀원이 상품 사용을 요청하면 여기에 표시됩니다."
              columns={[
                {
                  id: "product",
                  header: "상품",
                  cell: (row) => <span className="mono">{row.product_key}</span>,
                },
                { id: "user", header: "요청자", cell: (row) => row.user_id || "—" },
                { id: "team", header: "팀", cell: (row) => row.team || "—" },
                {
                  id: "reason",
                  header: "사유",
                  cell: (row) => <span className="truncate">{row.reason || "—"}</span>,
                },
                {
                  id: "status",
                  header: "상태",
                  cell: (row) => (
                    <Badge
                      tone={
                        row.status === "approved" ? "success" : row.status === "denied" ? "danger" : "info"
                      }
                    >
                      {requestStatusLabels[row.status] ?? row.status ?? "—"}
                    </Badge>
                  ),
                },
                { id: "created", header: "요청 시각", cell: (row) => formatDateTime(row.created_at) },
                {
                  id: "actions",
                  header: "작업",
                  cell: (row) =>
                    row.status === "pending" ? (
                      <div className="data-inline-actions">
                        <Button
                          size="small"
                          variant="ghost"
                          disabled={!canWrite}
                          title={canWrite ? undefined : writeDeniedReason}
                          aria-label={`${row.product_key} 요청 승인`}
                          onClick={(event) => {
                            actionTriggerRef.current = event.currentTarget;
                            setPending({ kind: "decide", request: row, action: "approve" });
                          }}
                        >
                          승인
                        </Button>
                        <Button
                          size="small"
                          variant="ghost"
                          disabled={!canWrite}
                          title={canWrite ? undefined : writeDeniedReason}
                          aria-label={`${row.product_key} 요청 거절`}
                          onClick={(event) => {
                            actionTriggerRef.current = event.currentTarget;
                            setPending({ kind: "decide", request: row, action: "deny" });
                          }}
                        >
                          거절
                        </Button>
                      </div>
                    ) : (
                      <span>{row.decided_by || "—"}</span>
                    ),
                },
              ]}
            />
          </SectionCard>
        </TabPanel>
      ) : null}

      {tab === "candidates" ? (
        <TabPanel id="candidates" panelIdPrefix="products">
          <SectionCard
            title="발행 후보"
            description="반복되는 Text2SQL 질문입니다. 원문 SQL은 노출하지 않습니다."
          >
            <Toolbar label="발행 후보 필터">
              <label className="data-filter" htmlFor="dp-window">
                <span>조회 구간</span>
                <Select
                  id="dp-window"
                  value={candidateWindow}
                  onChange={(event) => update({ window: event.target.value })}
                  options={candidateWindows.map((item) => ({
                    value: item,
                    label: candidateWindowLabels[item],
                  }))}
                />
              </label>
              <label className="data-filter" htmlFor="dp-min-count">
                <span>최소 반복 횟수</span>
                <Select
                  id="dp-min-count"
                  value={String(minCount)}
                  onChange={(event) => update({ min_count: event.target.value })}
                  options={[2, 3, 5, 10].map((item) => ({ value: String(item), label: `${item}회 이상` }))}
                />
              </label>
            </Toolbar>
            {candidates.isError ? (
              <DataQueryNotice
                error={candidates.error}
                hasPreviousData={Boolean(candidates.data)}
                label="발행 후보"
                onRetry={() => void candidates.refetch()}
              />
            ) : null}
            <SimpleTable<DataProductCandidate>
              caption="데이터 상품 발행 후보"
              loading={candidates.isPending}
              rows={candidates.data?.candidates ?? []}
              emptyMessage="반복 질문이 아직 없습니다. Text2SQL 사용이 쌓이면 후보가 나타납니다."
              columns={[
                {
                  id: "question",
                  header: "질문",
                  cell: (row) => <span className="truncate">{row.question}</span>,
                },
                {
                  id: "count",
                  header: "반복",
                  cell: (row) => <span className="cell-number">{formatNumber(row.count)}</span>,
                },
                { id: "last", header: "마지막 질문", cell: (row) => formatDateTime(row.last_seen) },
                { id: "recommended", header: "추천 상품", cell: (row) => row.recommended_product || "—" },
                {
                  id: "actions",
                  header: "작업",
                  cell: (row) => (
                    <Button
                      size="small"
                      variant="ghost"
                      disabled={!canWrite}
                      title={canWrite ? undefined : writeDeniedReason}
                      onClick={(event) => {
                        actionTriggerRef.current = event.currentTarget;
                        openCreate({
                          name_ko: row.recommended_product || row.question.slice(0, 60),
                          source_type: "golden_query",
                        });
                      }}
                    >
                      상품으로 등록
                    </Button>
                  ),
                },
              ]}
            />
          </SectionCard>
        </TabPanel>
      ) : null}

      <FormDialog
        form={form}
        open={formOpen}
        onOpenChange={setFormOpen}
        returnFocusRef={actionTriggerRef}
        title="데이터 상품"
        description="상품 키가 같으면 기존 상품을 덮어쓰고 버전을 올립니다."
        onSubmit={(values) => upsert.mutateAsync(values)}
      >
        <FormField label="상품 키" required error={form.formState.errors.product_key?.message}>
          {(control) => <Input {...control} {...form.register("product_key")} />}
        </FormField>
        <FormField label="상품 이름" required error={form.formState.errors.name_ko?.message}>
          {(control) => <Input {...control} {...form.register("name_ko")} />}
        </FormField>
        <FormField label="설명" error={form.formState.errors.description?.message}>
          {(control) => <Textarea {...control} rows={3} {...form.register("description")} />}
        </FormField>
        <FormField label="원천 유형" error={form.formState.errors.source_type?.message}>
          {(control) => (
            <Select
              {...control}
              {...form.register("source_type")}
              options={productSourceTypes.map((item) => ({
                value: item,
                label: productSourceTypeLabels[item] ?? item,
              }))}
            />
          )}
        </FormField>
        <FormField
          label="원천 참조"
          description="리포트 ID, 지표 키 등 원천 식별자입니다. SQL 원문은 넣지 마세요."
          error={form.formState.errors.source_ref?.message}
        >
          {(control) => <Input {...control} {...form.register("source_ref")} />}
        </FormField>
        <FormField label="담당자" error={form.formState.errors.owner?.message}>
          {(control) => <Input {...control} {...form.register("owner")} />}
        </FormField>
        <FormField
          label="공개 팀"
          description="쉼표로 구분합니다. 비우면 모든 팀에 공개됩니다."
          error={form.formState.errors.allowed_teams?.message}
        >
          {(control) => <Input {...control} {...form.register("allowed_teams")} />}
        </FormField>
        <FormField label="민감도" error={form.formState.errors.sensitivity?.message}>
          {(control) => (
            <Select
              {...control}
              {...form.register("sensitivity")}
              options={productSensitivities.map((item) => ({
                value: item,
                label: productSensitivityLabels[item] ?? item,
              }))}
            />
          )}
        </FormField>
        <FormField label="상태" error={form.formState.errors.status?.message}>
          {(control) => (
            <Select
              {...control}
              {...form.register("status")}
              options={productStatuses.map((item) => ({
                value: item,
                label: productStatusLabels[item] ?? item,
              }))}
            />
          )}
        </FormField>
      </FormDialog>

      <ConfirmDialog
        open={pending !== undefined}
        onOpenChange={(open) => {
          if (!open) setPending(undefined);
        }}
        returnFocusRef={actionTriggerRef}
        title={copy.title}
        description={copy.description}
        confirmLabel={copy.label}
        tone={copy.danger ? "danger" : "primary"}
        onConfirm={confirmPending}
      />
    </div>
  );
}
