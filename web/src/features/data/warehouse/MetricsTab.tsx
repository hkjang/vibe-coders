import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useRef, useState } from "react";
import { z } from "zod";

import { DataQueryNotice } from "@/features/data/DataQueryNotice";
import { SimpleTable } from "@/features/data/SimpleTable";
import { dataQueryKeys } from "@/features/data/warehouse/use-warehouse-queries";
import { metricSensitivities, metricSensitivityLabels } from "@/features/data/warehouse/warehouse-filters";
import { apiClient } from "@/shared/api/client";
import type { MetricEntry, MetricValidation } from "@/shared/api/domains/data.schemas";
import { withPathParams } from "@/shared/api/endpoint-factory";
import { endpoints } from "@/shared/api/endpoints";
import { FormDialog } from "@/shared/components/form/FormDialog";
import { FormField } from "@/shared/components/form/FormField";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { Checkbox } from "@/shared/components/ui/Checkbox";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { Sheet } from "@/shared/components/ui/Sheet";
import { Textarea } from "@/shared/components/ui/Textarea";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { useRefreshInterval } from "@/shared/hooks/use-refresh-interval";
import { formatDateTime, formatNumber } from "@/shared/utils/format";

const metrics = endpoints.domains.data.metrics;

const metricFormSchema = z.object({
  metric_key: z.string().trim().min(1, "지표 키를 입력하세요."),
  name_ko: z.string().trim().min(1, "지표 이름을 입력하세요."),
  description: z.string().trim(),
  dimensions: z.string().trim(),
  owner: z.string().trim(),
  sensitivity: z.enum(metricSensitivities),
  enabled: z.boolean(),
  query_template: z.string().trim().min(1, "집계 쿼리 템플릿을 입력하세요."),
});

const emptyMetric = {
  metric_key: "",
  name_ko: "",
  description: "",
  dimensions: "",
  owner: "",
  sensitivity: "internal" as const,
  enabled: false,
  query_template: "",
};

interface MetricsTabProps {
  canWrite: boolean;
}

const writeDeniedReason = "admin:write 권한이 필요합니다.";

export function MetricsTab({ canWrite }: MetricsTabProps): React.JSX.Element {
  const refetchInterval = useRefreshInterval();
  const list = useQuery({
    queryKey: [...dataQueryKeys.metrics, "list"],
    queryFn: ({ signal }) => apiClient.request(metrics.list, { signal }),
    refetchInterval,
  });
  const [formOpen, setFormOpen] = useState(false);
  const [selected, setSelected] = useState<MetricEntry | undefined>();
  const [validation, setValidation] = useState<MetricValidation | undefined>();
  const [validatedKey, setValidatedKey] = useState("");
  const [pendingDelete, setPendingDelete] = useState<MetricEntry | undefined>();
  const createTriggerRef = useRef<HTMLButtonElement>(null);
  const rowTriggerRef = useRef<HTMLElement>(null);
  const deleteTriggerRef = useRef<HTMLElement>(null);
  const form = useZodForm(metricFormSchema, emptyMetric);

  const upsert = useMutationFeedback({
    mutate: (values: z.infer<typeof metricFormSchema>) =>
      apiClient.request(metrics.upsert, {
        body: {
          metric_key: values.metric_key,
          name_ko: values.name_ko,
          description: values.description,
          query_template: values.query_template,
          dimensions: values.dimensions
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean),
          owner: values.owner,
          sensitivity: values.sensitivity,
          enabled: values.enabled,
        },
      }),
    invalidates: [dataQueryKeys.metrics],
    // The metric key is an operator-chosen identifier, never the query text.
    successMessage: (_result, values) => `지표 ${values.metric_key}을(를) 저장했습니다.`,
    errorMessage: "지표를 저장하지 못했습니다.",
    onSuccess: (result, values) => {
      setValidation(result.validation);
      setValidatedKey(values.metric_key);
    },
  });

  // `{key}` accepts the row id or the metric key; the id is stable across renames.
  const metricPathKey = (row: MetricEntry): string => row.id || row.metric_key;

  const revalidate = useMutationFeedback({
    mutate: (row: MetricEntry) =>
      apiClient.request(withPathParams(metrics.validate, { key: metricPathKey(row) })),
    successMessage: (_result, row) => `지표 ${row.metric_key}의 쿼리를 재검증했습니다.`,
    errorMessage: "지표 쿼리를 재검증하지 못했습니다.",
    onSuccess: (result, row) => {
      setValidation(result.validation);
      setValidatedKey(result.metric_key || row.metric_key);
    },
  });

  const remove = useMutationFeedback({
    mutate: (row: MetricEntry) =>
      apiClient.request(withPathParams(metrics.remove, { key: metricPathKey(row) })),
    invalidates: [dataQueryKeys.metrics],
    successMessage: (_result, row) => `지표 ${row.metric_key}을(를) 삭제했습니다.`,
    errorMessage: "지표를 삭제하지 못했습니다.",
    onSuccess: (_result, row) => {
      setPendingDelete(undefined);
      setValidation(undefined);
      setValidatedKey("");
      setSelected((current) => (current?.metric_key === row.metric_key ? undefined : current));
    },
  });

  return (
    <div className="data-section-stack">
      <SectionCard
        title="지표 카탈로그"
        description="표준 집계 쿼리를 등록해 데이터 상품과 리포트의 정의를 통일합니다."
        actions={
          <Button
            ref={createTriggerRef}
            variant="primary"
            disabled={!canWrite}
            title={canWrite ? undefined : writeDeniedReason}
            onClick={() => {
              form.reset(emptyMetric);
              setValidation(undefined);
              setFormOpen(true);
            }}
          >
            <Plus aria-hidden="true" /> 지표 추가
          </Button>
        }
      >
        {list.isError ? (
          <DataQueryNotice
            error={list.error}
            hasPreviousData={Boolean(list.data)}
            label="지표 카탈로그"
            onRetry={() => void list.refetch()}
          />
        ) : null}
        {validation ? (
          <InlineNotice
            tone={validation.ok ? "success" : "warning"}
            title={`${validatedKey || "지표"} — ${validation.ok ? "쿼리 정적 검증을 통과했습니다." : "쿼리 정적 검증에 문제가 있습니다."}`}
          >
            {validation.errors.length > 0 ? <p>오류: {validation.errors.join(", ")}</p> : null}
            {validation.warnings.length > 0 ? <p>경고: {validation.warnings.join(", ")}</p> : null}
            {validation.referenced_tables.length > 0 ? (
              <p>참조 테이블: {validation.referenced_tables.join(", ")}</p>
            ) : null}
          </InlineNotice>
        ) : null}
        <SimpleTable<MetricEntry>
          caption="등록된 지표 목록"
          loading={list.isPending}
          rows={list.data?.metrics ?? []}
          emptyMessage="등록된 지표가 없습니다. ‘지표 추가’로 첫 지표를 정의하세요."
          columns={[
            {
              id: "metric_key",
              header: "지표 키",
              cell: (row) => (
                <Button
                  size="small"
                  variant="ghost"
                  onClick={(event) => {
                    rowTriggerRef.current = event.currentTarget;
                    setSelected(row);
                  }}
                >
                  {row.metric_key}
                </Button>
              ),
            },
            { id: "name", header: "이름", cell: (row) => row.name_ko || "—" },
            { id: "owner", header: "담당자", cell: (row) => row.owner || "—" },
            {
              id: "sensitivity",
              header: "민감도",
              cell: (row) => (
                <Badge tone={row.sensitivity === "restricted" ? "warning" : "muted"}>
                  {metricSensitivityLabels[row.sensitivity] ?? row.sensitivity ?? "—"}
                </Badge>
              ),
            },
            {
              id: "enabled",
              header: "사용",
              cell: (row) => (
                <Badge tone={row.enabled ? "success" : "muted"}>{row.enabled ? "사용" : "중지"}</Badge>
              ),
            },
            {
              id: "version",
              header: "버전",
              cell: (row) => <span className="cell-number">{formatNumber(row.version)}</span>,
            },
            { id: "updated", header: "수정 시각", cell: (row) => formatDateTime(row.updated_at) },
            {
              id: "actions",
              header: "동작",
              cell: (row) => (
                <div className="data-row-actions">
                  <Button
                    size="small"
                    disabled={!canWrite || revalidate.isPending}
                    title={canWrite ? undefined : writeDeniedReason}
                    aria-label={`${row.metric_key} 쿼리 재검증`}
                    onClick={() => revalidate.mutate(row)}
                  >
                    재검증
                  </Button>
                  <Button
                    size="small"
                    variant="danger"
                    disabled={!canWrite}
                    title={canWrite ? undefined : writeDeniedReason}
                    aria-label={`${row.metric_key} 삭제`}
                    onClick={(event) => {
                      deleteTriggerRef.current = event.currentTarget;
                      setPendingDelete(row);
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

      <FormDialog
        form={form}
        open={formOpen}
        onOpenChange={setFormOpen}
        returnFocusRef={createTriggerRef}
        title="지표 정의"
        description="지표 키가 같으면 기존 정의를 덮어쓰고 버전을 올립니다."
        submitLabel="저장"
        onSubmit={(values) => upsert.mutateAsync(values)}
      >
        <FormField label="지표 키" required error={form.formState.errors.metric_key?.message}>
          {(control) => <Input {...control} {...form.register("metric_key")} />}
        </FormField>
        <FormField label="지표 이름" required error={form.formState.errors.name_ko?.message}>
          {(control) => <Input {...control} {...form.register("name_ko")} />}
        </FormField>
        <FormField label="설명" error={form.formState.errors.description?.message}>
          {(control) => <Input {...control} {...form.register("description")} />}
        </FormField>
        <FormField
          label="차원"
          description="쉼표로 구분합니다. 예: model, team"
          error={form.formState.errors.dimensions?.message}
        >
          {(control) => <Input {...control} {...form.register("dimensions")} />}
        </FormField>
        <FormField label="담당자" error={form.formState.errors.owner?.message}>
          {(control) => <Input {...control} {...form.register("owner")} />}
        </FormField>
        <FormField label="민감도" error={form.formState.errors.sensitivity?.message}>
          {(control) => (
            <Select
              {...control}
              {...form.register("sensitivity")}
              options={metricSensitivities.map((item) => ({
                value: item,
                label: metricSensitivityLabels[item] ?? item,
              }))}
            />
          )}
        </FormField>
        <FormField
          label="집계 쿼리 템플릿"
          required
          description="SELECT/WITH로 시작하는 읽기 전용 집계 쿼리만 허용합니다."
          error={form.formState.errors.query_template?.message}
        >
          {(control) => <Textarea {...control} rows={6} {...form.register("query_template")} />}
        </FormField>
        <Checkbox
          label="사용"
          description="검증에 실패한 쿼리는 사용 상태로 저장할 수 없습니다."
          {...form.register("enabled")}
        />
      </FormDialog>

      <Sheet
        open={selected !== undefined}
        onOpenChange={(open) => {
          if (!open) setSelected(undefined);
        }}
        returnFocusRef={rowTriggerRef}
        size="wide"
        title={selected?.metric_key ?? ""}
        description="지표 정의 상세"
      >
        <KeyValueList
          items={[
            { label: "이름", value: selected?.name_ko },
            { label: "설명", value: selected?.description },
            { label: "차원", value: selected?.dimensions.join(", ") },
            { label: "담당자", value: selected?.owner },
            {
              label: "민감도",
              value: selected ? (metricSensitivityLabels[selected.sensitivity] ?? selected.sensitivity) : "",
            },
            { label: "사용", value: selected?.enabled ? "사용" : "중지" },
            { label: "버전", value: selected ? formatNumber(selected.version) : "" },
            { label: "수정자", value: selected?.updated_by },
            { label: "수정 시각", value: formatDateTime(selected?.updated_at) },
          ]}
        />
        <h3>집계 쿼리 템플릿</h3>
        <pre className="data-query-preview" tabIndex={0} aria-label="집계 쿼리 템플릿">
          {selected?.query_template || "—"}
        </pre>
      </Sheet>

      <ConfirmDialog
        open={pendingDelete !== undefined}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(undefined);
        }}
        returnFocusRef={deleteTriggerRef}
        tone="danger"
        title="지표 정의를 삭제할까요?"
        description={`${pendingDelete?.metric_key ?? ""} 정의가 카탈로그에서 사라집니다. 이 지표를 참조하는 데이터 상품과 리포트는 더 이상 조회되지 않습니다.`}
        confirmLabel="삭제"
        onConfirm={async () => {
          if (pendingDelete) await remove.mutateAsync(pendingDelete);
        }}
      />
    </div>
  );
}
