import { useRef, useState } from "react";
import { z } from "zod";

import { PanelFailure, ReadOnlyNotice } from "@/features/text2sql/overview/text2sql-presentation";
import { writeDisabledTitle } from "@/features/text2sql/overview/text2sql-labels";
import { text2sqlInvalidations, text2sqlRouteId } from "@/features/text2sql/overview/use-text2sql-queries";
import { apiClient } from "@/shared/api/client";
import type { Text2SQLGlossaryTerm, Text2SQLPermissionRow } from "@/shared/api/domains/text2sql";
import { endpoints } from "@/shared/api/endpoints";
import { FormDialog } from "@/shared/components/form/FormDialog";
import { FormField } from "@/shared/components/form/FormField";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import { DataTable } from "@/shared/data-table/DataTable";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";

const permissionFormSchema = z
  .object({
    subject_type: z.enum(["team", "api_key", "user", "*"]),
    subject_id: z.string().trim(),
    schema_name: z.string().trim(),
    table_name: z.string().trim(),
    column_name: z.string().trim(),
    action: z.enum(["deny", "allow"]),
  })
  .refine((values) => values.subject_type === "*" || values.subject_id !== "", {
    message: "주체 ID를 입력하세요. (전체(*) 주체유형만 생략할 수 있습니다)",
    path: ["subject_id"],
  });
type PermissionFormValues = z.infer<typeof permissionFormSchema>;

const glossaryFormSchema = z.object({
  schema_name: z.string().trim(),
  term: z.string().trim().min(1, "업무 용어를 입력하세요."),
  mapping: z.string().trim().min(1, "매핑을 입력하세요."),
  description: z.string().trim(),
});
type GlossaryFormValues = z.infer<typeof glossaryFormSchema>;

interface Text2SqlAccessTabProps {
  canWrite: boolean;
  conflicts: ReadonlyArray<{ term: string; kind: string; mappings: readonly string[] }>;
  glossaryError: unknown;
  glossaryLoading: boolean;
  onRetryGlossary: () => void;
  permissions: readonly Text2SQLPermissionRow[];
  permissionsLoading: boolean;
  terms: readonly Text2SQLGlossaryTerm[];
}

export function Text2SqlAccessTab({
  canWrite,
  conflicts,
  glossaryError,
  glossaryLoading,
  onRetryGlossary,
  permissions,
  permissionsLoading,
  terms,
}: Text2SqlAccessTabProps): React.JSX.Element {
  const [permissionDialogOpen, setPermissionDialogOpen] = useState(false);
  const [glossaryDialogOpen, setGlossaryDialogOpen] = useState(false);
  const [permissionToDelete, setPermissionToDelete] = useState("");
  const [termToDelete, setTermToDelete] = useState("");
  const permissionTriggerRef = useRef<HTMLButtonElement>(null);
  const glossaryTriggerRef = useRef<HTMLButtonElement>(null);
  const rowTriggerRef = useRef<HTMLElement | null>(null);

  const permissionForm = useZodForm<PermissionFormValues, PermissionFormValues>(permissionFormSchema, {
    subject_type: "team",
    subject_id: "",
    schema_name: "",
    table_name: "",
    column_name: "",
    action: "deny",
  });
  const glossaryForm = useZodForm<GlossaryFormValues, GlossaryFormValues>(glossaryFormSchema, {
    schema_name: "",
    term: "",
    mapping: "",
    description: "",
  });

  const savePermission = useMutationFeedback({
    mutate: (values: PermissionFormValues) =>
      apiClient.request(endpoints.domains.text2sql.permissions.save, {
        body: values,
        routeId: text2sqlRouteId,
      }),
    invalidates: text2sqlInvalidations.overview,
    successMessage: "권한 규칙을 저장했습니다.",
  });
  const removePermission = useMutationFeedback({
    mutate: (id: string) =>
      apiClient.request(endpoints.domains.text2sql.permissions.remove, {
        query: { id },
        routeId: text2sqlRouteId,
      }),
    invalidates: text2sqlInvalidations.overview,
    successMessage: "권한 규칙을 삭제했습니다.",
  });
  const saveTerm = useMutationFeedback({
    mutate: (values: GlossaryFormValues) =>
      apiClient.request(endpoints.domains.text2sql.glossary.save, {
        body: values,
        routeId: text2sqlRouteId,
      }),
    invalidates: text2sqlInvalidations.glossary,
    successMessage: "업무 용어를 저장했습니다.",
  });
  const removeTerm = useMutationFeedback({
    mutate: (id: string) =>
      apiClient.request(endpoints.domains.text2sql.glossary.remove, {
        query: { id },
        routeId: text2sqlRouteId,
      }),
    invalidates: text2sqlInvalidations.glossary,
    successMessage: "업무 용어를 삭제했습니다.",
  });

  const permissionColumn = createDataTableColumnHelper<Text2SQLPermissionRow>();
  const permissionColumns = permissionColumn.columns([
    permissionColumn.accessor((row) => row.subject_type, { id: "subject_type", header: "주체 유형" }),
    permissionColumn.accessor((row) => row.subject_id, {
      id: "subject_id",
      header: "주체 ID",
      cell: ({ getValue }) => <code className="mono">{getValue()}</code>,
    }),
    permissionColumn.display({
      id: "target",
      header: "schema.table.column",
      cell: ({ row }) => (
        <code className="mono">
          {row.original.schema_name || "*"}.{row.original.table_name || "*"}.{row.original.column_name || "*"}
        </code>
      ),
    }),
    permissionColumn.accessor((row) => row.action, {
      id: "action",
      header: "동작",
      cell: ({ getValue }) => <Badge tone={getValue() === "deny" ? "danger" : "success"}>{getValue()}</Badge>,
    }),
    permissionColumn.display({
      id: "actions",
      header: "관리",
      cell: ({ row }) => (
        <Button
          size="small"
          variant="danger"
          disabled={!canWrite}
          title={writeDisabledTitle(canWrite)}
          onClick={(event) => {
            rowTriggerRef.current = event.currentTarget;
            setPermissionToDelete(row.original.id);
          }}
        >
          삭제
        </Button>
      ),
    }),
  ]) as Array<DataTableColumn<Text2SQLPermissionRow>>;

  const termColumn = createDataTableColumnHelper<Text2SQLGlossaryTerm>();
  const termColumns = termColumn.columns([
    termColumn.accessor((row) => row.term, {
      id: "term",
      header: "용어",
      cell: ({ getValue }) => <strong>{getValue()}</strong>,
    }),
    termColumn.accessor((row) => row.mapping, {
      id: "mapping",
      header: "매핑",
      cell: ({ getValue }) => <code className="mono truncate">{getValue()}</code>,
    }),
    termColumn.accessor((row) => row.description, {
      id: "description",
      header: "설명",
      cell: ({ getValue }) => getValue() || "—",
    }),
    termColumn.accessor((row) => row.schema_name, {
      id: "schema",
      header: "스키마",
      cell: ({ getValue }) => (getValue() === "*" || getValue() === "" ? "전역" : getValue()),
    }),
    termColumn.display({
      id: "actions",
      header: "관리",
      cell: ({ row }) => (
        <Button
          size="small"
          variant="danger"
          disabled={!canWrite}
          title={writeDisabledTitle(canWrite)}
          onClick={(event) => {
            rowTriggerRef.current = event.currentTarget;
            setTermToDelete(row.original.id);
          }}
        >
          삭제
        </Button>
      ),
    }),
  ]) as Array<DataTableColumn<Text2SQLGlossaryTerm>>;

  return (
    <div className="t2s-stack">
      <ReadOnlyNotice canWrite={canWrite} />

      <SectionCard
        title="권한 매트릭스 (주체 × schema/table/column)"
        description="deny 규칙은 테이블·컬럼 접근을 제한하고, allow 규칙은 민감(exclude) 컬럼 접근을 특정 주체에 부여합니다."
        actions={
          <Button
            ref={permissionTriggerRef}
            variant="primary"
            disabled={!canWrite}
            title={writeDisabledTitle(canWrite)}
            onClick={() => setPermissionDialogOpen(true)}
          >
            권한 규칙 추가
          </Button>
        }
      >
        <DataTable
          caption="Text2SQL 권한 매트릭스"
          columns={permissionColumns}
          data={permissions}
          loading={permissionsLoading}
          getRowId={(row) => row.id}
          emptyMessage="권한 규칙이 없습니다. 규칙을 추가하면 주체별로 테이블·컬럼 접근을 제어할 수 있습니다."
        />
      </SectionCard>

      <SectionCard
        title="업무 용어 사전 (자연어 → SQL 매핑)"
        description="등록하면 사용자가 업무 언어로 질문할 때 매핑이 프롬프트에 주입됩니다."
        actions={
          <Button
            ref={glossaryTriggerRef}
            variant="primary"
            disabled={!canWrite}
            title={writeDisabledTitle(canWrite)}
            onClick={() => setGlossaryDialogOpen(true)}
          >
            용어 추가
          </Button>
        }
      >
        {conflicts.length > 0 ? (
          <InlineNotice tone="warning" title={`용어 충돌 ${conflicts.length}건`}>
            <ul>
              {conflicts.map((conflict) => (
                <li key={`${conflict.term}-${conflict.kind}`}>
                  {conflict.term} ({conflict.kind}) → {conflict.mappings.join(" | ")}
                </li>
              ))}
            </ul>
          </InlineNotice>
        ) : null}
        {glossaryError ? (
          <PanelFailure
            error={glossaryError}
            hasData={terms.length > 0}
            label="업무 용어 사전"
            onRetry={onRetryGlossary}
          />
        ) : null}
        <DataTable
          caption="Text2SQL 업무 용어 사전"
          columns={termColumns}
          data={terms}
          loading={glossaryLoading}
          getRowId={(row) => row.id}
          emptyMessage="업무 용어 사전이 비어 있습니다. 용어를 등록하면 질문 해석 정확도가 올라갑니다."
        />
      </SectionCard>

      <FormDialog
        open={permissionDialogOpen}
        onOpenChange={(next) => {
          setPermissionDialogOpen(next);
          if (!next) permissionForm.reset();
        }}
        form={permissionForm}
        returnFocusRef={permissionTriggerRef}
        title="권한 규칙 추가"
        description="비워 둔 schema/table/column은 전체(*)로 저장됩니다."
        submitLabel="추가"
        onSubmit={async (values) => {
          await savePermission.mutateAsync(values);
        }}
      >
        <FormField label="주체 유형" required error={permissionForm.formState.errors.subject_type?.message}>
          {(control) => (
            <Select
              {...control}
              {...permissionForm.register("subject_type")}
              options={[
                { value: "team", label: "team" },
                { value: "api_key", label: "api_key" },
                { value: "user", label: "user" },
                { value: "*", label: "전체(*)" },
              ]}
            />
          )}
        </FormField>
        <FormField label="주체 ID" error={permissionForm.formState.errors.subject_id?.message}>
          {(control) => <Input {...control} {...permissionForm.register("subject_id")} />}
        </FormField>
        <FormField label="schema" error={permissionForm.formState.errors.schema_name?.message}>
          {(control) => <Input {...control} {...permissionForm.register("schema_name")} placeholder="*" />}
        </FormField>
        <FormField label="table" error={permissionForm.formState.errors.table_name?.message}>
          {(control) => <Input {...control} {...permissionForm.register("table_name")} placeholder="*" />}
        </FormField>
        <FormField label="column" error={permissionForm.formState.errors.column_name?.message}>
          {(control) => <Input {...control} {...permissionForm.register("column_name")} placeholder="*" />}
        </FormField>
        <FormField label="동작" required error={permissionForm.formState.errors.action?.message}>
          {(control) => (
            <Select
              {...control}
              {...permissionForm.register("action")}
              options={[
                { value: "deny", label: "deny (차단)" },
                { value: "allow", label: "allow (허용)" },
              ]}
            />
          )}
        </FormField>
      </FormDialog>

      <FormDialog
        open={glossaryDialogOpen}
        onOpenChange={(next) => {
          setGlossaryDialogOpen(next);
          if (!next) glossaryForm.reset();
        }}
        form={glossaryForm}
        returnFocusRef={glossaryTriggerRef}
        title="업무 용어 추가"
        description="업무 용어를 SQL 조건이나 컬럼으로 매핑합니다."
        onSubmit={async (values) => {
          await saveTerm.mutateAsync(values);
        }}
      >
        <FormField
          label="스키마명"
          description="비우면 전역 용어가 됩니다."
          error={glossaryForm.formState.errors.schema_name?.message}
        >
          {(control) => <Input {...control} {...glossaryForm.register("schema_name")} />}
        </FormField>
        <FormField label="업무 용어" required error={glossaryForm.formState.errors.term?.message}>
          {(control) => <Input {...control} {...glossaryForm.register("term")} placeholder="활성 고객" />}
        </FormField>
        <FormField label="매핑" required error={glossaryForm.formState.errors.mapping?.message}>
          {(control) => (
            <Input
              {...control}
              {...glossaryForm.register("mapping")}
              placeholder="users WHERE status='active'"
            />
          )}
        </FormField>
        <FormField label="설명" error={glossaryForm.formState.errors.description?.message}>
          {(control) => <Input {...control} {...glossaryForm.register("description")} />}
        </FormField>
      </FormDialog>

      <ConfirmDialog
        open={permissionToDelete !== ""}
        onOpenChange={(next) => {
          if (!next) setPermissionToDelete("");
        }}
        returnFocusRef={rowTriggerRef}
        tone="danger"
        title="권한 규칙 삭제"
        description="이 규칙을 삭제하면 해당 주체의 접근 제어가 즉시 사라집니다."
        confirmLabel="삭제"
        onConfirm={async () => {
          await removePermission.mutateAsync(permissionToDelete);
          setPermissionToDelete("");
        }}
      />

      <ConfirmDialog
        open={termToDelete !== ""}
        onOpenChange={(next) => {
          if (!next) setTermToDelete("");
        }}
        returnFocusRef={rowTriggerRef}
        tone="danger"
        title="업무 용어 삭제"
        description="이 용어의 매핑이 더 이상 프롬프트에 주입되지 않습니다."
        confirmLabel="삭제"
        onConfirm={async () => {
          await removeTerm.mutateAsync(termToDelete);
          setTermToDelete("");
        }}
      />
    </div>
  );
}
