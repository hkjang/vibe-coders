import { useRef, useState } from "react";
import { z } from "zod";

import {
  PanelFailure,
  ReadOnlyNotice,
  StatusBadge,
} from "@/features/text2sql/overview/text2sql-presentation";
import { writeDisabledTitle } from "@/features/text2sql/overview/text2sql-labels";
import { text2sqlInvalidations, text2sqlRouteId } from "@/features/text2sql/overview/use-text2sql-queries";
import { apiClient } from "@/shared/api/client";
import type {
  Text2SQLConnectionRow,
  Text2SQLFeatureRow,
  Text2SQLHealthcheck,
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
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { Switch } from "@/shared/components/ui/Switch";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import { DataTable } from "@/shared/data-table/DataTable";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";

const profileFormSchema = z.object({
  virtual_model: z
    .string()
    .trim()
    .min(1, "가상 모델명을 입력하세요.")
    .refine((value) => value.toLowerCase().startsWith("vibe/text2sql"), {
      message: "가상 모델명은 vibe/text2sql 로 시작해야 합니다.",
    }),
  mode: z.enum(["preview", "execute"]),
  upstream_model: z.string().trim(),
  summary_model: z.string().trim(),
  schema_name: z.string().trim(),
  exec_connection_id: z.string().trim(),
});
type ProfileFormValues = z.infer<typeof profileFormSchema>;

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
  killSwitchDisabled: boolean;
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
  killSwitchDisabled,
  onRefetchConnections,
  onRefetchFeatures,
  profiles,
  profilesLoading,
}: Text2SqlRuntimeTabProps): React.JSX.Element {
  const [profileDialogOpen, setProfileDialogOpen] = useState(false);
  const [connectionDialogOpen, setConnectionDialogOpen] = useState(false);
  const [profileToDelete, setProfileToDelete] = useState("");
  const [killConfirmOpen, setKillConfirmOpen] = useState(false);
  const [health, setHealth] = useState<{ id: string; result: Text2SQLHealthcheck } | undefined>();
  const [healthError, setHealthError] = useState<string | undefined>();
  const [healthPending, setHealthPending] = useState("");
  const profileTriggerRef = useRef<HTMLButtonElement>(null);
  const connectionTriggerRef = useRef<HTMLButtonElement>(null);
  const killTriggerRef = useRef<HTMLButtonElement>(null);
  const rowTriggerRef = useRef<HTMLElement | null>(null);

  const profileForm = useZodForm<ProfileFormValues, ProfileFormValues>(profileFormSchema, {
    virtual_model: "",
    mode: "preview",
    upstream_model: "",
    summary_model: "",
    schema_name: "",
    exec_connection_id: "",
  });
  const connectionForm = useZodForm<ConnectionFormValues, ConnectionFormValues>(connectionFormSchema, {
    id: "",
    name: "",
    driver: "sqlite",
    dsn: "",
    description: "",
  });
  const selectedDriver = connectionForm.watch("driver");

  const saveProfile = useMutationFeedback({
    mutate: (values: ProfileFormValues) =>
      apiClient.request(endpoints.domains.text2sql.profiles.save, {
        body: { ...values, enabled: true },
        routeId: text2sqlRouteId,
      }),
    invalidates: text2sqlInvalidations.overview,
    successMessage: "런타임 프로필을 저장했습니다.",
  });
  const removeProfile = useMutationFeedback({
    mutate: (virtualModel: string) =>
      apiClient.request(endpoints.domains.text2sql.profiles.remove, {
        query: { virtual_model: virtualModel },
        routeId: text2sqlRouteId,
      }),
    invalidates: text2sqlInvalidations.overview,
    successMessage: "런타임 프로필을 삭제했습니다.",
  });
  const saveConnection = useMutationFeedback({
    mutate: (values: ConnectionFormValues) =>
      apiClient.request(endpoints.domains.text2sql.connections.save, {
        body: { ...values, enabled: true },
        routeId: text2sqlRouteId,
      }),
    invalidates: text2sqlInvalidations.connections,
    successMessage: "실행 DB 연결을 저장했습니다.",
  });
  const toggleFeature = useMutationFeedback({
    mutate: (variables: { name: string; enabled: boolean }) =>
      apiClient.request(endpoints.domains.text2sql.features.toggle, {
        body: variables,
        routeId: text2sqlRouteId,
      }),
    invalidates: text2sqlInvalidations.features,
    successMessage: (_result, variables) =>
      `${variables.name} 기능을 ${variables.enabled ? "켰습니다" : "껐습니다"}.`,
  });
  const setKillSwitch = useMutationFeedback({
    mutate: (disabled: boolean) =>
      apiClient.request(endpoints.domains.text2sql.killSwitch.set, {
        body: { disabled },
        routeId: text2sqlRouteId,
      }),
    invalidates: text2sqlInvalidations.killSwitch,
    successMessage: (_result, disabled) =>
      disabled ? "Text2SQL을 전체 중지했습니다." : "Text2SQL 중지를 해제했습니다.",
  });

  const runHealthcheck = async (connectionId: string): Promise<void> => {
    setHealthPending(connectionId || "default");
    setHealthError(undefined);
    try {
      const result = await apiClient.request(endpoints.domains.text2sql.connections.healthcheck, {
        query: connectionId ? { connection_id: connectionId } : {},
        routeId: text2sqlRouteId,
      });
      setHealth({ id: connectionId || "기본(ENV)", result });
    } catch (cause) {
      setHealth(undefined);
      const requestId = isAppError(cause) ? cause.requestId : undefined;
      setHealthError(
        `${safeAppErrorMessage(cause, "헬스체크를 실행하지 못했습니다.")}${requestId ? ` (요청 ID: ${requestId})` : ""}`,
      );
    } finally {
      setHealthPending("");
    }
  };

  const profileColumn = createDataTableColumnHelper<Text2SQLProfileRow>();
  const profileColumns = profileColumn.columns([
    profileColumn.accessor((row) => row.virtual_model, {
      id: "virtual_model",
      header: "가상 모델",
      cell: ({ row }) => (
        <div className="t2s-cell-stack">
          <code className="mono">{row.original.virtual_model}</code>
          {row.original.enabled ? null : <Badge tone="danger">중지</Badge>}
        </div>
      ),
    }),
    profileColumn.accessor((row) => row.mode, { id: "mode", header: "모드" }),
    profileColumn.accessor((row) => row.upstream_model, {
      id: "upstream",
      header: "업스트림",
      cell: ({ getValue }) => getValue() || "—",
    }),
    profileColumn.accessor((row) => row.summary_model, {
      id: "summary",
      header: "요약 모델",
      cell: ({ getValue }) => getValue() || "—",
    }),
    profileColumn.accessor((row) => row.schema_name, {
      id: "schema",
      header: "스키마",
      cell: ({ getValue }) => getValue() || "—",
    }),
    profileColumn.accessor((row) => row.exec_connection_id, {
      id: "connection",
      header: "실행 DB",
      cell: ({ getValue }) => getValue() || "기본(ENV)",
    }),
    profileColumn.display({
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
            setProfileToDelete(row.original.virtual_model);
          }}
        >
          삭제
        </Button>
      ),
    }),
  ]) as Array<DataTableColumn<Text2SQLProfileRow>>;

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
        <Button
          size="small"
          disabled={healthPending !== ""}
          onClick={() => void runHealthcheck(row.original.id)}
        >
          {healthPending === row.original.id ? "확인 중" : "헬스체크"}
        </Button>
      ),
    }),
  ]) as Array<DataTableColumn<Text2SQLConnectionRow>>;

  return (
    <div className="t2s-stack">
      <ReadOnlyNotice canWrite={canWrite} />

      <SectionCard
        title="런타임 프로필 (DB 오버라이드 · 신규 가상 모델)"
        description="환경 기본값을 덮어쓰거나 새 vibe/text2sql-* 가상 모델을 추가합니다."
        actions={
          <Button
            ref={profileTriggerRef}
            variant="primary"
            disabled={!canWrite}
            title={writeDisabledTitle(canWrite)}
            onClick={() => setProfileDialogOpen(true)}
          >
            프로필 추가
          </Button>
        }
      >
        <DataTable
          caption="런타임 Text2SQL 프로필"
          columns={profileColumns}
          data={profiles}
          loading={profilesLoading}
          getRowId={(row) => row.virtual_model}
          emptyMessage="런타임 프로필이 없습니다. 추가하면 환경 기본값을 덮어쓰거나 새 가상 모델을 정의할 수 있습니다."
        />
      </SectionCard>

      <SectionCard
        title="실행 DB 연결 관리"
        description="프로필이 SQL을 실행할 읽기 전용 데이터베이스입니다. DSN은 입력 전용이며 저장 후 다시 표시되지 않습니다."
        actions={
          <>
            <Button disabled={healthPending !== ""} onClick={() => void runHealthcheck("")}>
              기본(ENV) 헬스체크
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
          <InlineNotice tone="danger" title="헬스체크 실패">
            {healthError}
          </InlineNotice>
        ) : null}
        {health ? (
          <InlineNotice
            tone={
              health.result.status === "ok" ? "success" : health.result.status === "warn" ? "warning" : "info"
            }
            title={`헬스체크 결과 — ${health.id}`}
          >
            <KeyValueList
              items={[
                { label: "상태", value: <StatusBadge value={health.result.status} /> },
                { label: "설명", value: health.result.detail },
                { label: "드라이버", value: health.result.driver },
                { label: "문장 제한 시간", value: health.result.statement_timeout },
                { label: "read-only 트랜잭션", value: health.result.read_only_tx_ok ? "정상" : "실패" },
                {
                  label: "계정 쓰기 제한",
                  value:
                    health.result.account_write_restricted === null ||
                    health.result.account_write_restricted === undefined
                      ? "확인 안 함"
                      : health.result.account_write_restricted
                        ? "읽기 전용"
                        : "쓰기 가능",
                },
              ]}
            />
          </InlineNotice>
        ) : null}
        <InlineNotice tone="info" title="연결 삭제는 기존 화면에서">
          연결 삭제 API는 아직 이 콘솔의 API 계약에 포함되어 있지 않습니다. 삭제가 필요하면 기존 화면에서
          진행하세요.
        </InlineNotice>
      </SectionCard>

      <SectionCard
        title="기능 토글 (런타임 온오프)"
        description="Text2SQL 파이프라인의 선택 기능과 전체 중지 스위치입니다."
      >
        {featuresError ? (
          <PanelFailure
            error={featuresError}
            hasData={features.length > 0}
            label="기능 토글"
            onRetry={onRefetchFeatures}
          />
        ) : null}
        <ul className="t2s-toggle-list">
          <li>
            <div>
              <strong>kill_switch</strong>
              <p>Text2SQL 전체 즉시 중지 (장애·비용·보안 대응)</p>
            </div>
            <Switch
              ref={killTriggerRef}
              checked={killSwitchDisabled}
              disabled={!canWrite || setKillSwitch.isPending}
              title={writeDisabledTitle(canWrite)}
              label={killSwitchDisabled ? "중지됨" : "정상"}
              onCheckedChange={(next) => {
                if (next) setKillConfirmOpen(true);
                else setKillSwitch.mutate(false);
              }}
            />
          </li>
          {featuresLoading && features.length === 0 ? (
            <li>
              <div role="status">기능 목록을 불러오는 중입니다.</div>
            </li>
          ) : null}
          {features.map((feature) => (
            <li key={feature.name}>
              <div>
                <strong>{feature.name}</strong>
                <p>{feature.description}</p>
              </div>
              <Switch
                checked={feature.enabled}
                disabled={!canWrite || toggleFeature.isPending}
                title={writeDisabledTitle(canWrite)}
                label={feature.enabled ? "켜짐" : "꺼짐"}
                onCheckedChange={(enabled) => toggleFeature.mutate({ name: feature.name, enabled })}
              />
            </li>
          ))}
        </ul>
      </SectionCard>

      <FormDialog
        open={profileDialogOpen}
        onOpenChange={(next) => {
          setProfileDialogOpen(next);
          if (!next) profileForm.reset();
        }}
        form={profileForm}
        returnFocusRef={profileTriggerRef}
        title="런타임 프로필 추가"
        description="가상 모델을 업스트림 모델·스키마·실행 DB에 연결합니다."
        onSubmit={async (values) => {
          await saveProfile.mutateAsync(values);
        }}
      >
        <FormField
          label="가상 모델"
          required
          description="예: vibe/text2sql-finance"
          error={profileForm.formState.errors.virtual_model?.message}
        >
          {(control) => <Input {...control} {...profileForm.register("virtual_model")} />}
        </FormField>
        <FormField label="모드" required error={profileForm.formState.errors.mode?.message}>
          {(control) => (
            <Select
              {...control}
              {...profileForm.register("mode")}
              options={[
                { value: "preview", label: "preview (생성만)" },
                { value: "execute", label: "execute (실행까지)" },
              ]}
            />
          )}
        </FormField>
        <FormField label="업스트림 모델" error={profileForm.formState.errors.upstream_model?.message}>
          {(control) => <Input {...control} {...profileForm.register("upstream_model")} />}
        </FormField>
        <FormField label="요약 모델" error={profileForm.formState.errors.summary_model?.message}>
          {(control) => <Input {...control} {...profileForm.register("summary_model")} />}
        </FormField>
        <FormField label="스키마명" error={profileForm.formState.errors.schema_name?.message}>
          {(control) => <Input {...control} {...profileForm.register("schema_name")} />}
        </FormField>
        <FormField label="실행 DB 연결" error={profileForm.formState.errors.exec_connection_id?.message}>
          {(control) => (
            <Select {...control} {...profileForm.register("exec_connection_id")}>
              <option value="">기본(ENV)</option>
              {connections.map((connection) => (
                <option key={connection.id} value={connection.id}>
                  {connection.name}
                  {connection.enabled ? "" : " (중지)"}
                </option>
              ))}
            </Select>
          )}
        </FormField>
      </FormDialog>

      <FormDialog
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
        open={profileToDelete !== ""}
        onOpenChange={(next) => {
          if (!next) setProfileToDelete("");
        }}
        returnFocusRef={rowTriggerRef}
        tone="danger"
        title="런타임 프로필 삭제"
        description={`${profileToDelete} 프로필을 삭제하면 이 가상 모델은 환경 기본값으로 되돌아갑니다.`}
        confirmLabel="삭제"
        onConfirm={async () => {
          await removeProfile.mutateAsync(profileToDelete);
          setProfileToDelete("");
        }}
      />

      <ConfirmDialog
        open={killConfirmOpen}
        onOpenChange={setKillConfirmOpen}
        returnFocusRef={killTriggerRef}
        tone="danger"
        title="Text2SQL 전체 중지"
        description="모든 vibe/text2sql-* 요청이 SQL을 생성하지 않고 안전 메시지를 반환합니다."
        confirmLabel="중지"
        onConfirm={async () => {
          await setKillSwitch.mutateAsync(true);
        }}
      />
    </div>
  );
}
