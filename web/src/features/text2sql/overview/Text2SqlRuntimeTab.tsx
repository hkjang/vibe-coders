import { ProfileList } from "../profiles/ProfileList";
import { Text2SqlFeatureControls } from "./Text2SqlFeatureControls";
import { Text2SqlHealthResult } from "./Text2SqlHealthResult";
import { useRef, useState } from "react";
import { z } from "zod";

import { PanelFailure, ReadOnlyNotice } from "@/features/text2sql/overview/text2sql-presentation";
import { writeDisabledTitle } from "@/features/text2sql/overview/text2sql-labels";
import { text2sqlInvalidations, text2sqlRouteId } from "@/features/text2sql/overview/use-text2sql-queries";
import { apiClient } from "@/shared/api/client";
import type {
  Text2SQLConnectionRow,
  Text2SQLFeatureRow,
  Text2SQLProfileRow,
} from "@/shared/api/domains/text2sql";
import { endpoints } from "@/shared/api/endpoints";
import { isAppError } from "@/shared/api/error";
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
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { useText2SqlMutation } from "./use-text2sql-mutation";

const connectionFormSchema = z.object({
  id: z
    .string()
    .trim()
    .min(1, "ID를 입력하세요.")
    .regex(/^[a-zA-Z0-9_-]+$/u, "ID는 영문·숫자·하이픈·밑줄만 사용할 수 있습니다."),
  name: z.string().trim().min(1, "표시 이름을 입력하세요."),
  driver: z.enum(["sqlite", "postgres", "mysql", "mariadb", "oracle"]),
  dsn: z.string(),
  description: z.string().trim(),
});
type ConnectionFormValues = z.infer<typeof connectionFormSchema>;

const driverOptions = [
  { value: "sqlite", label: "SQLite" },
  { value: "postgres", label: "PostgreSQL" },
  { value: "mysql", label: "MySQL" },
  { value: "mariadb", label: "MariaDB" },
  { value: "oracle", label: "Oracle" },
];

const dsnHints: Record<string, string> = {
  sqlite: "파일 경로 또는 :memory:",
  postgres: "host=... user=... dbname=... sslmode=disable",
  mysql: "user:password@tcp(host:3306)/dbname",
  mariadb: "user:password@tcp(host:3306)/dbname",
  oracle: "oracle://user:password@host:1521/service",
};

interface Text2SqlRuntimeTabProps {
  canWrite: boolean;
  connections: readonly Text2SQLConnectionRow[];
  connectionsError: unknown;
  connectionsLoading: boolean;
  features: readonly Text2SQLFeatureRow[];
  featuresError: unknown;
  featuresLoading: boolean;
  onRefetchConnections: () => void;
  onRefetchFeatures: () => void;
  profiles: readonly Text2SQLProfileRow[];
  profilesLoading: boolean;
}

export function Text2SqlRuntimeTab({
  canWrite,
  connections,
  connectionsError,
  connectionsLoading,
  features,
  featuresError,
  featuresLoading,
  onRefetchConnections,
  onRefetchFeatures,
  profiles,
  profilesLoading,
}: Text2SqlRuntimeTabProps): React.JSX.Element {
  const [connectionDialogOpen, setConnectionDialogOpen] = useState(false);
  const [connectionToDelete, setConnectionToDelete] = useState<Text2SQLConnectionRow | undefined>();
  const connectionTriggerRef = useRef<HTMLButtonElement>(null);
  const connectionRowTriggerRef = useRef<HTMLElement | null>(null);

  const connectionForm = useZodForm<ConnectionFormValues, ConnectionFormValues>(connectionFormSchema, {
    id: "",
    name: "",
    driver: "sqlite",
    dsn: "",
    description: "",
  });
  const selectedDriver = connectionForm.watch("driver");

  const saveConnection = useText2SqlMutation({
    authorized: canWrite,
    mutate: (values: ConnectionFormValues) =>
      apiClient.request(endpoints.domains.text2sql.connections.save, {
        body: { ...values, enabled: true },
        routeId: text2sqlRouteId,
      }),
    invalidates: text2sqlInvalidations.connections,
    successMessage: "실행 DB 연결을 저장했습니다.",
  });
  const removeConnection = useText2SqlMutation({
    authorized: canWrite,
    mutate: (connectionId: string) =>
      apiClient.request(endpoints.domains.text2sql.connections.remove, {
        query: { id: connectionId },
        routeId: text2sqlRouteId,
      }),
    invalidates: text2sqlInvalidations.connections,
    successMessage: (_result, connectionId) => `실행 DB 연결 삭제 완료: ${connectionId}`,
    errorMessage: "실행 DB 연결을 삭제하지 못했습니다.",
  });

  const healthcheck = useText2SqlMutation({
    readOnly: true,
    mutate: (connectionId: string) =>
      apiClient.request(endpoints.domains.text2sql.connections.healthcheck, {
        query: connectionId ? { connection_id: connectionId } : {},
        routeId: text2sqlRouteId,
      }),
    errorMessage: "연결을 점검하지 못했습니다.",
  });
  const health = healthcheck.data
    ? { id: healthcheck.variables || "기본(환경 변수)", result: healthcheck.data }
    : undefined;
  const healthRequestId = isAppError(healthcheck.error) ? healthcheck.error.requestId : undefined;
  const healthError = healthcheck.error
    ? `${safeAppErrorMessage(healthcheck.error, "연결을 점검하지 못했습니다.")}${healthRequestId ? ` (요청 ID: ${healthRequestId})` : ""}`
    : undefined;
  const healthPending = healthcheck.isPending ? healthcheck.variables || "default" : "";
  const runHealthcheck = (connectionId: string): void => healthcheck.mutate(connectionId);

  const connectionColumn = createDataTableColumnHelper<Text2SQLConnectionRow>();
  const connectionColumns = connectionColumn.columns([
    connectionColumn.accessor((row) => row.id, {
      id: "id",
      header: "ID",
      cell: ({ row }) => (
        <div className="t2s-cell-stack">
          <code className="mono">{row.original.id}</code>
          {row.original.enabled ? null : <Badge tone="danger">중지</Badge>}
        </div>
      ),
    }),
    connectionColumn.accessor((row) => row.name, { id: "name", header: "이름" }),
    connectionColumn.accessor((row) => row.driver, { id: "driver", header: "드라이버" }),
    connectionColumn.accessor((row) => row.description, {
      id: "description",
      header: "설명",
      cell: ({ getValue }) => getValue() || "—",
    }),
    connectionColumn.display({
      id: "actions",
      header: "동작",
      cell: ({ row }) => (
        <div className="t2s-row-actions">
          <Button
            size="small"
            disabled={healthPending !== ""}
            onClick={() => void runHealthcheck(row.original.id)}
          >
            {healthPending === row.original.id ? "확인 중" : "연결 점검"}
          </Button>
          <Button
            size="small"
            variant="danger"
            disabled={!canWrite}
            title={writeDisabledTitle(canWrite)}
            aria-label={`${row.original.id} 연결 삭제`}
            onClick={(event) => {
              connectionRowTriggerRef.current = event.currentTarget;
              setConnectionToDelete(row.original);
            }}
          >
            삭제
          </Button>
        </div>
      ),
    }),
  ]) as Array<DataTableColumn<Text2SQLConnectionRow>>;

  return (
    <div className="t2s-stack">
      <ReadOnlyNotice canWrite={canWrite} />

      <ProfileList
        canWrite={canWrite}
        profiles={profiles}
        profilesLoading={profilesLoading}
        connections={connections}
        connectionsLoading={connectionsLoading}
        connectionsError={connectionsError}
      />

      <SectionCard
        title="실행 DB 연결 관리"
        description="프로필이 SQL을 실행할 읽기 전용 데이터베이스입니다. DSN은 입력 전용이며 저장 후 다시 표시되지 않습니다."
        actions={
          <>
            <Button disabled={healthPending !== ""} onClick={() => void runHealthcheck("")}>
              기본(환경 변수) 연결 점검
            </Button>
            <Button
              ref={connectionTriggerRef}
              variant="primary"
              disabled={!canWrite}
              title={writeDisabledTitle(canWrite)}
              onClick={() => setConnectionDialogOpen(true)}
            >
              연결 추가
            </Button>
          </>
        }
      >
        {connectionsError ? (
          <PanelFailure
            error={connectionsError}
            hasData={connections.length > 0}
            label="실행 DB 연결"
            onRetry={onRefetchConnections}
          />
        ) : null}
        <DataTable
          caption="Text2SQL 실행 DB 연결"
          columns={connectionColumns}
          data={connections}
          loading={connectionsLoading}
          getRowId={(row) => row.id}
          emptyMessage="등록된 실행 DB 연결이 없습니다. 등록하지 않으면 환경 변수 TEXT2SQL_EXEC_DSN을 사용합니다."
        />
        {healthError ? (
          <InlineNotice tone="danger" title="연결 점검 실패">
            {healthError}
          </InlineNotice>
        ) : null}
        {health ? <Text2SqlHealthResult connectionId={health.id} result={health.result} /> : null}
      </SectionCard>

      <Text2SqlFeatureControls
        canWrite={canWrite}
        features={features}
        error={featuresError}
        loading={featuresLoading}
        onRetry={onRefetchFeatures}
      />

      <FormDialog
        submitDisabled={!canWrite}
        open={connectionDialogOpen}
        onOpenChange={(next) => {
          setConnectionDialogOpen(next);
          if (!next) connectionForm.reset();
        }}
        form={connectionForm}
        returnFocusRef={connectionTriggerRef}
        title="실행 DB 연결 추가"
        description="DSN은 서버에서 암호화 저장되며 조회 API로 다시 노출되지 않습니다."
        onSubmit={async (values) => {
          await saveConnection.mutateAsync(values);
        }}
      >
        <FormField label="ID (슬러그)" required error={connectionForm.formState.errors.id?.message}>
          {(control) => <Input {...control} {...connectionForm.register("id")} />}
        </FormField>
        <FormField label="표시 이름" required error={connectionForm.formState.errors.name?.message}>
          {(control) => <Input {...control} {...connectionForm.register("name")} />}
        </FormField>
        <FormField label="드라이버" required error={connectionForm.formState.errors.driver?.message}>
          {(control) => (
            <Select {...control} {...connectionForm.register("driver")} options={driverOptions} />
          )}
        </FormField>
        <FormField
          label="DSN"
          description={dsnHints[selectedDriver] ?? "DSN"}
          error={connectionForm.formState.errors.dsn?.message}
        >
          {(control) => (
            <Input
              {...control}
              {...connectionForm.register("dsn")}
              type="password"
              autoComplete="new-password"
              placeholder={dsnHints[selectedDriver] ?? "DSN"}
            />
          )}
        </FormField>
        <FormField label="설명" error={connectionForm.formState.errors.description?.message}>
          {(control) => <Input {...control} {...connectionForm.register("description")} />}
        </FormField>
      </FormDialog>

      <ConfirmDialog
        confirmDisabled={!canWrite}
        open={connectionToDelete !== undefined}
        onOpenChange={(next) => {
          if (!next) setConnectionToDelete(undefined);
        }}
        returnFocusRef={connectionRowTriggerRef}
        tone="danger"
        title="실행 DB 연결 삭제"
        description={`${connectionToDelete?.name ?? ""} 연결을 삭제하면 이 연결을 쓰던 프로필은 SQL을 실행하지 못합니다. 저장된 DSN도 함께 삭제됩니다.`}
        confirmLabel="삭제"
        onConfirm={async () => {
          if (connectionToDelete) await removeConnection.mutateAsync(connectionToDelete.id);
          setConnectionToDelete(undefined);
        }}
      />
    </div>
  );
}
