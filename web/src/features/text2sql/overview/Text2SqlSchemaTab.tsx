import { useRef, useState, type ChangeEvent } from "react";
import { z } from "zod";

import {
  PanelFailure,
  ReadOnlyNotice,
  SensitivityBadge,
} from "@/features/text2sql/overview/text2sql-presentation";
import { sensitivityOptions, writeDisabledTitle } from "@/features/text2sql/overview/text2sql-labels";
import { text2sqlInvalidations, text2sqlRouteId } from "@/features/text2sql/overview/use-text2sql-queries";
import { apiClient } from "@/shared/api/client";
import type {
  Text2SQLColumnRow,
  Text2SQLConnectionRow,
  Text2SQLSchemaRow,
  Text2SQLTableRow,
} from "@/shared/api/domains/text2sql";
import { endpoints } from "@/shared/api/endpoints";
import { isAppError } from "@/shared/api/error";
import { FormDialog } from "@/shared/components/form/FormDialog";
import { FormField } from "@/shared/components/form/FormField";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { Textarea } from "@/shared/components/ui/Textarea";
import { Toolbar } from "@/shared/components/ui/Toolbar";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import { DataTable } from "@/shared/data-table/DataTable";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { downloadText } from "@/shared/utils/csv";

const schemaFormSchema = z.object({
  name: z.string().trim().min(1, "스키마 이름을 입력하세요."),
  team: z.string().trim(),
  dialect: z.string().trim(),
  schema_text: z.string().trim().min(1, "프롬프트 컨텍스트로 쓸 스키마 설명을 입력하세요."),
  allowed_tables: z.string(),
});
type SchemaFormValues = z.infer<typeof schemaFormSchema>;

const tableFormSchema = z.object({
  table_name: z.string().trim().min(1, "테이블명을 입력하세요."),
  description: z.string().trim(),
});
type TableFormValues = z.infer<typeof tableFormSchema>;

const columnFormSchema = z.object({
  table_name: z.string().trim().min(1, "테이블명을 입력하세요."),
  column_name: z.string().trim().min(1, "컬럼명을 입력하세요."),
  data_type: z.string().trim(),
  description: z.string().trim(),
  sensitivity: z.enum(["normal", "mask", "aggregate_only", "approval_required", "exclude"]),
});
type ColumnFormValues = z.infer<typeof columnFormSchema>;

const sampleBundle = {
  version: 1,
  tables: [{ schema_name: "analytics", table_name: "orders", description: "주문 테이블", enabled: true }],
  columns: [
    {
      schema_name: "analytics",
      table_name: "orders",
      column_name: "order_id",
      data_type: "bigint",
      description: "주문 고유 ID",
      sensitivity: "normal",
    },
    {
      schema_name: "analytics",
      table_name: "orders",
      column_name: "phone",
      data_type: "text",
      description: "고객 전화번호",
      sensitivity: "mask",
    },
  ],
};

interface Text2SqlSchemaTabProps {
  canWrite: boolean;
  columns: readonly Text2SQLColumnRow[];
  connections: readonly Text2SQLConnectionRow[];
  onRegistrySchemaChange: (schema: string) => void;
  onRetryRegistry: () => void;
  registryError: unknown;
  registryLoading: boolean;
  registrySchema: string;
  schemas: readonly Text2SQLSchemaRow[];
  schemasLoading: boolean;
  tables: readonly Text2SQLTableRow[];
}

export function Text2SqlSchemaTab({
  canWrite,
  columns,
  connections,
  onRegistrySchemaChange,
  onRetryRegistry,
  registryError,
  registryLoading,
  registrySchema,
  schemas,
  schemasLoading,
  tables,
}: Text2SqlSchemaTabProps): React.JSX.Element {
  const [schemaDialogOpen, setSchemaDialogOpen] = useState(false);
  const [tableDialogOpen, setTableDialogOpen] = useState(false);
  const [columnDialogOpen, setColumnDialogOpen] = useState(false);
  const [schemaToDelete, setSchemaToDelete] = useState("");
  const [tableToDelete, setTableToDelete] = useState("");
  const [columnToDelete, setColumnToDelete] = useState<{ table: string; column: string } | undefined>();
  const [schemaInput, setSchemaInput] = useState(registrySchema);
  const [collectConnection, setCollectConnection] = useState("");
  const [registryMessage, setRegistryMessage] = useState<
    { tone: "success" | "danger"; text: string } | undefined
  >();
  const schemaTriggerRef = useRef<HTMLButtonElement>(null);
  const tableTriggerRef = useRef<HTMLButtonElement>(null);
  const columnTriggerRef = useRef<HTMLButtonElement>(null);
  const rowTriggerRef = useRef<HTMLElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const schemaForm = useZodForm<SchemaFormValues, SchemaFormValues>(schemaFormSchema, {
    name: "",
    team: "",
    dialect: "",
    schema_text: "",
    allowed_tables: "",
  });
  const tableForm = useZodForm<TableFormValues, TableFormValues>(tableFormSchema, {
    table_name: "",
    description: "",
  });
  const columnForm = useZodForm<ColumnFormValues, ColumnFormValues>(columnFormSchema, {
    table_name: "",
    column_name: "",
    data_type: "",
    description: "",
    sensitivity: "normal",
  });

  const saveSchema = useMutationFeedback({
    mutate: (values: SchemaFormValues) =>
      apiClient.request(endpoints.domains.text2sql.schemas.save, {
        body: {
          name: values.name,
          team: values.team,
          dialect: values.dialect,
          schema_text: values.schema_text,
          allowed_tables: values.allowed_tables
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean),
        },
        routeId: text2sqlRouteId,
      }),
    invalidates: text2sqlInvalidations.overview,
    successMessage: "스키마 카탈로그를 저장했습니다.",
  });
  const removeSchema = useMutationFeedback({
    mutate: (name: string) =>
      apiClient.request(endpoints.domains.text2sql.schemas.remove, {
        query: { name },
        routeId: text2sqlRouteId,
      }),
    invalidates: text2sqlInvalidations.overview,
    successMessage: "스키마 카탈로그를 삭제했습니다.",
  });
  const saveTable = useMutationFeedback({
    mutate: (values: TableFormValues) =>
      apiClient.request(endpoints.domains.text2sql.registry.saveTable, {
        body: { schema_name: registrySchema, ...values },
        routeId: text2sqlRouteId,
      }),
    invalidates: text2sqlInvalidations.registry,
    successMessage: "테이블을 등록했습니다.",
  });
  const removeTable = useMutationFeedback({
    mutate: (table: string) =>
      apiClient.request(endpoints.domains.text2sql.registry.removeTable, {
        query: { schema: registrySchema, table },
        routeId: text2sqlRouteId,
      }),
    invalidates: text2sqlInvalidations.registry,
    successMessage: "테이블을 삭제했습니다.",
  });
  const removeColumn = useMutationFeedback({
    mutate: (target: { table: string; column: string }) =>
      apiClient.request(endpoints.domains.text2sql.registry.removeColumn, {
        query: { schema: registrySchema, table: target.table, column: target.column },
        routeId: text2sqlRouteId,
      }),
    invalidates: text2sqlInvalidations.registry,
    successMessage: "컬럼을 삭제했습니다.",
  });
  const saveColumn = useMutationFeedback({
    mutate: (values: ColumnFormValues) =>
      apiClient.request(endpoints.domains.text2sql.registry.saveColumn, {
        body: { schema_name: registrySchema, ...values },
        routeId: text2sqlRouteId,
      }),
    invalidates: text2sqlInvalidations.registry,
    successMessage: "컬럼을 등록했습니다.",
  });
  const collect = useMutationFeedback({
    mutate: () =>
      apiClient.request(endpoints.domains.text2sql.registry.collect, {
        body: {
          schema_name: registrySchema,
          ...(collectConnection ? { connection_id: collectConnection } : {}),
        },
        routeId: text2sqlRouteId,
      }),
    invalidates: text2sqlInvalidations.registry,
    onSuccess: (result) =>
      setRegistryMessage({
        tone: "success",
        text: `테이블 ${result.added_tables}개 · 컬럼 ${result.added_columns}개를 레지스트리에 추가했습니다.`,
      }),
  });
  const importBundle = useMutationFeedback({
    mutate: (bundle: { tables: Record<string, unknown>[]; columns: Record<string, unknown>[] }) =>
      apiClient.request(endpoints.domains.text2sql.registry.import, {
        body: bundle,
        routeId: text2sqlRouteId,
      }),
    invalidates: text2sqlInvalidations.registry,
    onSuccess: (result) =>
      setRegistryMessage({
        tone: "success",
        text: `가져오기 완료 — 테이블 ${result.tables_imported}개, 컬럼 ${result.columns_imported}개 (오류 ${result.table_errors + result.column_errors}건)`,
      }),
  });

  const exportRegistry = async (): Promise<void> => {
    setRegistryMessage(undefined);
    try {
      const bundle = await apiClient.request(endpoints.domains.text2sql.registry.export, {
        query: registrySchema ? { schema: registrySchema } : {},
        routeId: text2sqlRouteId,
      });
      downloadText(
        `t2s-registry${registrySchema ? `-${registrySchema}` : ""}.json`,
        JSON.stringify(bundle, null, 2),
        "application/json",
      );
      setRegistryMessage({
        tone: "success",
        text: `내보내기 완료 (테이블 ${bundle.tables.length}개, 컬럼 ${bundle.columns.length}개)`,
      });
    } catch (cause) {
      const requestId = isAppError(cause) ? cause.requestId : undefined;
      setRegistryMessage({
        tone: "danger",
        text: `${safeAppErrorMessage(cause, "내보내기에 실패했습니다.")}${requestId ? ` (요청 ID: ${requestId})` : ""}`,
      });
    }
  };

  const importFile = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setRegistryMessage(undefined);
    try {
      const parsed: unknown = JSON.parse(await file.text());
      const bundle = parsed as { tables?: Record<string, unknown>[]; columns?: Record<string, unknown>[] };
      await importBundle.mutateAsync({ tables: bundle.tables ?? [], columns: bundle.columns ?? [] });
    } catch {
      setRegistryMessage({ tone: "danger", text: "JSON 파일을 읽지 못했습니다. 형식을 확인하세요." });
    }
  };

  const schemaColumn = createDataTableColumnHelper<Text2SQLSchemaRow>();
  const schemaColumns = schemaColumn.columns([
    schemaColumn.accessor((row) => row.name, {
      id: "name",
      header: "이름",
      cell: ({ row }) => (
        <div className="t2s-cell-stack">
          <strong>{row.original.name}</strong>
          <span className="badge-list">
            {row.original.is_default ? <Badge tone="info">기본</Badge> : null}
            {row.original.enabled ? null : <Badge tone="danger">중지</Badge>}
            <Badge tone="muted">v{row.original.version}</Badge>
          </span>
        </div>
      ),
    }),
    schemaColumn.accessor((row) => row.team, {
      id: "team",
      header: "팀",
      cell: ({ getValue }) => getValue() || "전역",
    }),
    schemaColumn.accessor((row) => row.dialect, {
      id: "dialect",
      header: "Dialect",
      cell: ({ getValue }) => getValue() || "—",
    }),
    schemaColumn.accessor((row) => row.allowed_tables.length, {
      id: "tables",
      header: "허용 테이블",
      cell: ({ row }) =>
        row.original.allowed_tables.length > 0 ? row.original.allowed_tables.join(", ") : "전체",
    }),
    schemaColumn.display({
      id: "actions",
      header: "동작",
      cell: ({ row }) => (
        <div className="table-actions">
          <Button
            size="small"
            onClick={() => {
              setSchemaInput(row.original.name);
              onRegistrySchemaChange(row.original.name);
            }}
          >
            레지스트리 열기
          </Button>
          <Button
            size="small"
            variant="danger"
            disabled={!canWrite}
            title={writeDisabledTitle(canWrite)}
            onClick={(event) => {
              rowTriggerRef.current = event.currentTarget;
              setSchemaToDelete(row.original.name);
            }}
          >
            삭제
          </Button>
        </div>
      ),
    }),
  ]) as Array<DataTableColumn<Text2SQLSchemaRow>>;

  const columnsByTable = new Map<string, Text2SQLColumnRow[]>();
  for (const entry of columns) {
    const list = columnsByTable.get(entry.table_name) ?? [];
    list.push(entry);
    columnsByTable.set(entry.table_name, list);
  }

  const tableColumn = createDataTableColumnHelper<Text2SQLTableRow>();
  const tableColumns = tableColumn.columns([
    tableColumn.accessor((row) => row.table_name, {
      id: "table",
      header: "테이블",
      cell: ({ row }) => (
        <div className="t2s-cell-stack">
          <strong>{row.original.table_name}</strong>
          {row.original.enabled ? null : <Badge tone="danger">중지</Badge>}
          <span>{row.original.description || "설명 없음"}</span>
        </div>
      ),
    }),
    tableColumn.display({
      id: "columns",
      header: "컬럼 (민감도)",
      cell: ({ row }) => {
        const list = columnsByTable.get(row.original.table_name) ?? [];
        if (list.length === 0) return "컬럼 없음";
        return (
          <ul className="t2s-column-list">
            {list.map((entry) => (
              <li key={entry.column_name}>
                <code className="mono">{entry.column_name}</code>
                <SensitivityBadge value={entry.sensitivity} />
                <Button
                  size="small"
                  variant="ghost"
                  disabled={!canWrite}
                  title={writeDisabledTitle(canWrite)}
                  aria-label={`${entry.table_name}.${entry.column_name} 컬럼 삭제`}
                  onClick={(event) => {
                    rowTriggerRef.current = event.currentTarget;
                    setColumnToDelete({ table: entry.table_name, column: entry.column_name });
                  }}
                >
                  삭제
                </Button>
              </li>
            ))}
          </ul>
        );
      },
    }),
    tableColumn.display({
      id: "actions",
      header: "동작",
      cell: ({ row }) => (
        <Button
          size="small"
          variant="danger"
          disabled={!canWrite}
          title={writeDisabledTitle(canWrite)}
          onClick={(event) => {
            rowTriggerRef.current = event.currentTarget;
            setTableToDelete(row.original.table_name);
          }}
        >
          삭제
        </Button>
      ),
    }),
  ]) as Array<DataTableColumn<Text2SQLTableRow>>;

  return (
    <div className="t2s-stack">
      <ReadOnlyNotice canWrite={canWrite} />

      <SectionCard
        title="스키마 카탈로그 · 테이블 권한"
        description="SQL 생성 프롬프트에 주입되는 스키마 설명과 검증에 쓰이는 허용 테이블 목록입니다."
        actions={
          <Button
            ref={schemaTriggerRef}
            variant="primary"
            disabled={!canWrite}
            title={writeDisabledTitle(canWrite)}
            onClick={() => setSchemaDialogOpen(true)}
          >
            스키마 등록
          </Button>
        }
      >
        <DataTable
          caption="Text2SQL 스키마 카탈로그"
          columns={schemaColumns}
          data={schemas}
          loading={schemasLoading}
          getRowId={(row) => row.name}
          emptyMessage="등록된 스키마 카탈로그가 없습니다. 등록하면 프롬프트 컨텍스트와 테이블 허용 목록으로 사용됩니다."
        />
      </SectionCard>

      <SectionCard
        title="스키마 레지스트리 (테이블 · 컬럼 · 민감도)"
        description="프록시 내부 DB에 저장된 테이블·컬럼 목록입니다. exclude 컬럼은 프롬프트에서 제외되고 SQL에서 참조하면 차단됩니다."
      >
        <Toolbar label="스키마 레지스트리 도구">
          <label className="t2s-inline-field">
            <span>스키마명</span>
            <Input
              value={schemaInput}
              onChange={(event) => setSchemaInput(event.target.value)}
              placeholder="예: analytics"
            />
          </label>
          <Button
            variant="primary"
            onClick={() => {
              setRegistryMessage(undefined);
              onRegistrySchemaChange(schemaInput.trim());
            }}
          >
            레지스트리 불러오기
          </Button>
          <label className="t2s-inline-field">
            <span>수집 DB</span>
            <Select value={collectConnection} onChange={(event) => setCollectConnection(event.target.value)}>
              <option value="">기본(ENV)</option>
              {connections.map((connection) => (
                <option key={connection.id} value={connection.id}>
                  {connection.name}
                </option>
              ))}
            </Select>
          </label>
          <Button
            disabled={!canWrite || registrySchema === "" || collect.isPending}
            title={registrySchema === "" ? "먼저 스키마를 불러오세요." : writeDisabledTitle(canWrite)}
            onClick={() => collect.mutate()}
          >
            {collect.isPending ? "수집 중" : "실행DB에서 자동 수집"}
          </Button>
          <Button onClick={() => void exportRegistry()}>JSON 내보내기</Button>
          <Button
            disabled={!canWrite}
            title={writeDisabledTitle(canWrite)}
            onClick={() => fileInputRef.current?.click()}
          >
            JSON 가져오기
          </Button>
          <Button
            onClick={() =>
              downloadText(
                "t2s-registry-sample.json",
                JSON.stringify(sampleBundle, null, 2),
                "application/json",
              )
            }
          >
            샘플 JSON
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            className="sr-only"
            aria-label="레지스트리 JSON 파일 선택"
            onChange={(event) => void importFile(event)}
          />
        </Toolbar>

        {registryMessage ? (
          <InlineNotice tone={registryMessage.tone}>{registryMessage.text}</InlineNotice>
        ) : null}

        {registrySchema === "" ? (
          <EmptyState
            title="스키마를 선택하세요."
            description="스키마명을 입력하고 '레지스트리 불러오기'를 누르면 등록된 테이블과 컬럼이 표시됩니다."
          />
        ) : (
          <>
            <Toolbar label="레지스트리 항목 추가">
              <span className="t2s-current-schema">
                현재 스키마 <code className="mono">{registrySchema}</code>
              </span>
              <Button
                ref={tableTriggerRef}
                disabled={!canWrite}
                title={writeDisabledTitle(canWrite)}
                onClick={() => setTableDialogOpen(true)}
              >
                테이블 추가
              </Button>
              <Button
                ref={columnTriggerRef}
                disabled={!canWrite}
                title={writeDisabledTitle(canWrite)}
                onClick={() => setColumnDialogOpen(true)}
              >
                컬럼 추가
              </Button>
            </Toolbar>
            {registryError ? (
              <PanelFailure
                error={registryError}
                hasData={tables.length > 0}
                label="스키마 레지스트리"
                onRetry={onRetryRegistry}
              />
            ) : null}
            <DataTable
              caption={`${registrySchema} 스키마 레지스트리`}
              columns={tableColumns}
              data={tables}
              loading={registryLoading}
              getRowId={(row) => row.table_name}
              emptyMessage={`${registrySchema} 스키마에 등록된 테이블이 없습니다.`}
            />
          </>
        )}
      </SectionCard>

      <FormDialog
        open={schemaDialogOpen}
        onOpenChange={(next) => {
          setSchemaDialogOpen(next);
          if (!next) schemaForm.reset();
        }}
        form={schemaForm}
        returnFocusRef={schemaTriggerRef}
        title="스키마 카탈로그 등록"
        description="클라이언트는 X-Text2SQL-Schema-Name 헤더로 이 스키마를 선택할 수 있습니다."
        onSubmit={async (values) => {
          await saveSchema.mutateAsync(values);
        }}
      >
        <FormField label="이름" required error={schemaForm.formState.errors.name?.message}>
          {(control) => <Input {...control} {...schemaForm.register("name")} placeholder="analytics" />}
        </FormField>
        <FormField
          label="팀"
          description="비우면 전역 스키마가 됩니다."
          error={schemaForm.formState.errors.team?.message}
        >
          {(control) => <Input {...control} {...schemaForm.register("team")} />}
        </FormField>
        <FormField label="Dialect" error={schemaForm.formState.errors.dialect?.message}>
          {(control) => <Input {...control} {...schemaForm.register("dialect")} placeholder="PostgreSQL" />}
        </FormField>
        <FormField
          label="스키마 설명"
          required
          description="테이블·컬럼 설명이 프롬프트 컨텍스트로 주입됩니다."
          error={schemaForm.formState.errors.schema_text?.message}
        >
          {(control) => <Textarea {...control} rows={6} {...schemaForm.register("schema_text")} />}
        </FormField>
        <FormField
          label="허용 테이블"
          description="콤마로 구분합니다. 비우면 전체 테이블을 허용합니다."
          error={schemaForm.formState.errors.allowed_tables?.message}
        >
          {(control) => <Input {...control} {...schemaForm.register("allowed_tables")} />}
        </FormField>
      </FormDialog>

      <FormDialog
        open={tableDialogOpen}
        onOpenChange={(next) => {
          setTableDialogOpen(next);
          if (!next) tableForm.reset();
        }}
        form={tableForm}
        returnFocusRef={tableTriggerRef}
        title={`테이블 등록 — ${registrySchema}`}
        description="레지스트리에 테이블과 업무 설명을 추가합니다."
        onSubmit={async (values) => {
          await saveTable.mutateAsync(values);
        }}
      >
        <FormField label="테이블명" required error={tableForm.formState.errors.table_name?.message}>
          {(control) => <Input {...control} {...tableForm.register("table_name")} />}
        </FormField>
        <FormField label="테이블 업무 설명" error={tableForm.formState.errors.description?.message}>
          {(control) => <Input {...control} {...tableForm.register("description")} />}
        </FormField>
      </FormDialog>

      <FormDialog
        open={columnDialogOpen}
        onOpenChange={(next) => {
          setColumnDialogOpen(next);
          if (!next) columnForm.reset();
        }}
        form={columnForm}
        returnFocusRef={columnTriggerRef}
        title={`컬럼 등록 — ${registrySchema}`}
        description="컬럼 설명과 민감도를 지정합니다. exclude는 프롬프트에서 제외되고 SQL 참조 시 차단됩니다."
        onSubmit={async (values) => {
          await saveColumn.mutateAsync(values);
        }}
      >
        <FormField label="테이블명" required error={columnForm.formState.errors.table_name?.message}>
          {(control) => <Input {...control} {...columnForm.register("table_name")} />}
        </FormField>
        <FormField label="컬럼명" required error={columnForm.formState.errors.column_name?.message}>
          {(control) => <Input {...control} {...columnForm.register("column_name")} />}
        </FormField>
        <FormField label="타입" error={columnForm.formState.errors.data_type?.message}>
          {(control) => <Input {...control} {...columnForm.register("data_type")} />}
        </FormField>
        <FormField label="컬럼 업무 설명" error={columnForm.formState.errors.description?.message}>
          {(control) => <Input {...control} {...columnForm.register("description")} />}
        </FormField>
        <FormField label="민감도" required error={columnForm.formState.errors.sensitivity?.message}>
          {(control) => (
            <Select
              {...control}
              {...columnForm.register("sensitivity")}
              options={sensitivityOptions.map((option) => ({ value: option.value, label: option.label }))}
            />
          )}
        </FormField>
      </FormDialog>

      <ConfirmDialog
        open={schemaToDelete !== ""}
        onOpenChange={(next) => {
          if (!next) setSchemaToDelete("");
        }}
        returnFocusRef={rowTriggerRef}
        tone="danger"
        title="스키마 카탈로그 삭제"
        description={`${schemaToDelete} 스키마를 삭제하면 이 스키마를 참조하는 프로필과 요청이 기본 스키마로 처리됩니다.`}
        confirmLabel="삭제"
        onConfirm={async () => {
          await removeSchema.mutateAsync(schemaToDelete);
          setSchemaToDelete("");
        }}
      />

      <ConfirmDialog
        open={columnToDelete !== undefined}
        onOpenChange={(next) => {
          if (!next) setColumnToDelete(undefined);
        }}
        returnFocusRef={rowTriggerRef}
        tone="danger"
        title="레지스트리 컬럼 삭제"
        description={`${columnToDelete?.table ?? ""}.${columnToDelete?.column ?? ""} 컬럼을 레지스트리에서 삭제합니다.`}
        confirmLabel="삭제"
        onConfirm={async () => {
          if (!columnToDelete) return;
          await removeColumn.mutateAsync(columnToDelete);
          setColumnToDelete(undefined);
        }}
      />

      <ConfirmDialog
        open={tableToDelete !== ""}
        onOpenChange={(next) => {
          if (!next) setTableToDelete("");
        }}
        returnFocusRef={rowTriggerRef}
        tone="danger"
        title="레지스트리 테이블 삭제"
        description={`${tableToDelete} 테이블과 등록된 컬럼이 함께 삭제됩니다.`}
        confirmLabel="삭제"
        onConfirm={async () => {
          await removeTable.mutateAsync(tableToDelete);
          setTableToDelete("");
        }}
      />
    </div>
  );
}
