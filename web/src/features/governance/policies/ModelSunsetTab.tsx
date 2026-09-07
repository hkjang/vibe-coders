import { useQuery } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { z } from "zod";

import {
  GovernanceTable,
  PanelFailure,
  type GovernanceColumn,
} from "@/features/governance/policies/governance-parts";
import { apiClient } from "@/shared/api/client";
import type { ModelDeprecation } from "@/shared/api/domains/governance";
import { pathWithParams } from "@/shared/api/endpoint-factory";
import { endpoints } from "@/shared/api/endpoints";
import { FormDialog } from "@/shared/components/form/FormDialog";
import { FormField } from "@/shared/components/form/FormField";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { Input } from "@/shared/components/ui/Input";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { formatDate } from "@/shared/utils/format";

const routeId = "governance.policies";

const deprecationSchema = z.object({
  modelGlob: z.string().trim().min(1, "모델 패턴을 입력하세요."),
  replacement: z.string().trim().max(200),
  sunsetDate: z
    .string()
    .trim()
    .refine((value) => value === "" || /^\d{4}-\d{2}-\d{2}$/u.test(value), "YYYY-MM-DD 형식이어야 합니다."),
  message: z.string().trim().max(500),
});
type DeprecationValues = z.infer<typeof deprecationSchema>;

export function ModelSunsetTab({ canWrite }: { canWrite: boolean }): React.JSX.Element {
  const [formOpen, setFormOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ModelDeprecation | undefined>();
  const createTriggerRef = useRef<HTMLButtonElement>(null);
  const rowTriggerRef = useRef<HTMLButtonElement | null>(null);

  const deprecations = useQuery({
    queryKey: ["governance", "model-deprecations"],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.governance.modelDeprecations.list, { signal, routeId }),
  });

  const form = useZodForm<DeprecationValues, DeprecationValues>(deprecationSchema, {
    modelGlob: "",
    replacement: "",
    sunsetDate: "",
    message: "",
  });

  const createDeprecation = useMutationFeedback({
    mutate: (values: DeprecationValues) =>
      apiClient.request(endpoints.domains.governance.modelDeprecations.create, {
        body: {
          model_glob: values.modelGlob,
          replacement: values.replacement,
          sunset_date: values.sunsetDate,
          message: values.message,
        },
        routeId,
      }),
    invalidates: [["governance", "model-deprecations"]],
    successMessage: "모델 일몰 정책을 저장했습니다.",
    errorMessage: "모델 일몰 정책을 저장하지 못했습니다.",
  });

  const removeDeprecation = useMutationFeedback({
    mutate: (id: string) =>
      apiClient.request(
        {
          ...endpoints.domains.governance.modelDeprecations.remove,
          path: pathWithParams(endpoints.domains.governance.modelDeprecations.remove.path, { id }),
        },
        { routeId },
      ),
    invalidates: [["governance", "model-deprecations"]],
    successMessage: "모델 일몰 정책을 삭제했습니다.",
    errorMessage: "모델 일몰 정책을 삭제하지 못했습니다.",
  });

  const rows = deprecations.data?.deprecations ?? [];

  const columns: ReadonlyArray<GovernanceColumn<ModelDeprecation>> = [
    { id: "glob", header: "모델 패턴", cell: (row) => <span className="mono">{row.model_glob}</span> },
    {
      id: "replacement",
      header: "대체 모델",
      cell: (row) =>
        row.replacement ? (
          <span className="mono">{row.replacement}</span>
        ) : (
          <Badge tone="danger">일몰 후 차단</Badge>
        ),
    },
    {
      id: "sunset",
      header: "일몰일",
      cell: (row) => (row.sunset_date ? formatDate(row.sunset_date) : "경고만"),
    },
    { id: "message", header: "안내 문구", cell: (row) => row.message || "—" },
    {
      id: "actions",
      header: "동작",
      cell: (row) => (
        <Button
          size="small"
          variant="danger"
          disabled={!canWrite}
          title={canWrite ? undefined : "admin:write 권한이 필요합니다."}
          aria-label={`${row.model_glob ?? row.id} 일몰 정책 삭제`}
          onClick={(event) => {
            rowTriggerRef.current = event.currentTarget;
            setPendingDelete(row);
          }}
        >
          <Trash2 aria-hidden="true" /> 삭제
        </Button>
      ),
    },
  ];

  return (
    <div className="page-stack">
      <SectionCard
        title="모델 일몰 정책"
        description="일몰일이 지나면 요청 모델을 대체 모델로 바꾸거나 차단합니다. 대체 모델이 비어 있으면 차단합니다."
        actions={
          <Button
            ref={createTriggerRef}
            variant="primary"
            disabled={!canWrite}
            title={canWrite ? undefined : "admin:write 권한이 필요합니다."}
            onClick={() => setFormOpen(true)}
          >
            <Plus aria-hidden="true" /> 일몰 정책 추가
          </Button>
        }
      >
        {deprecations.isError ? (
          <PanelFailure
            error={deprecations.error}
            hasData={Boolean(deprecations.data)}
            label="모델 일몰 정책"
            onRetry={() => void deprecations.refetch()}
          />
        ) : null}
        {!deprecations.isPending && !deprecations.isError && rows.length === 0 ? (
          <EmptyState
            title="등록된 모델 일몰 정책이 없습니다."
            description="일몰 정책을 추가하면 오래된 모델 사용을 미리 경고하고 자동으로 대체할 수 있습니다."
          />
        ) : (
          <GovernanceTable
            caption="모델 일몰 정책 목록"
            columns={columns}
            rows={rows}
            loading={deprecations.isPending}
            error={
              deprecations.isError && !deprecations.data ? "일몰 정책을 불러오지 못했습니다." : undefined
            }
            onRetry={() => void deprecations.refetch()}
          />
        )}
      </SectionCard>

      <FormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        returnFocusRef={createTriggerRef}
        form={form}
        title="모델 일몰 정책 추가"
        description="모델 패턴은 glob(예: gpt-3.5-*)으로 지정합니다."
        submitLabel="저장"
        onSubmit={async (values) => {
          await createDeprecation.mutateAsync(values);
        }}
      >
        <FormField label="모델 패턴" required error={form.formState.errors.modelGlob?.message}>
          {(control) => <Input {...control} {...form.register("modelGlob")} placeholder="gpt-3.5-*" />}
        </FormField>
        <FormField
          label="대체 모델"
          description="비워 두면 일몰 후 요청을 차단합니다."
          error={form.formState.errors.replacement?.message}
        >
          {(control) => <Input {...control} {...form.register("replacement")} />}
        </FormField>
        <FormField
          label="일몰일"
          description="비워 두면 경고만 표시합니다."
          error={form.formState.errors.sunsetDate?.message}
        >
          {(control) => <Input {...control} type="date" {...form.register("sunsetDate")} />}
        </FormField>
        <FormField label="안내 문구" error={form.formState.errors.message?.message}>
          {(control) => <Input {...control} {...form.register("message")} />}
        </FormField>
      </FormDialog>

      <ConfirmDialog
        open={pendingDelete !== undefined}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(undefined);
        }}
        returnFocusRef={rowTriggerRef}
        title="모델 일몰 정책을 삭제할까요?"
        description={`"${pendingDelete?.model_glob ?? ""}" 정책을 삭제합니다. 되돌릴 수 없습니다.`}
        confirmLabel="삭제"
        tone="danger"
        onConfirm={async () => {
          if (pendingDelete) await removeDeprecation.mutateAsync(pendingDelete.id);
        }}
      />
    </div>
  );
}
