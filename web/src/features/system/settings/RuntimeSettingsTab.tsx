import { Download, RefreshCw } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";

import { QueryNotice, UpdatedAt } from "@/features/system/settings/SettingsParts";
import { SettingDetailSheet } from "@/features/system/settings/SettingDetailSheet";
import {
  filterSettings,
  isConsoleSetting,
  settingCategories,
  settingDisplayValue,
  settingEditPermission,
  settingSourceLabel,
} from "@/features/system/settings/settings-utils";
import {
  routeId,
  systemSettingsKeys,
  useEffectiveSettings,
} from "@/features/system/settings/use-system-settings";
import { apiClient } from "@/shared/api/client";
import type { EffectiveSetting } from "@/shared/api/domains/system.schemas";
import { pathWithParams } from "@/shared/api/endpoint-factory";
import { endpoints } from "@/shared/api/endpoints";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { Select } from "@/shared/components/ui/Select";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { Toolbar } from "@/shared/components/ui/Toolbar";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import { DataTable } from "@/shared/data-table/DataTable";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { containsPotentialSecret, secretSearchMessage } from "@/shared/security/secrets";
import { downloadText } from "@/shared/utils/csv";
import { formatDateTime, formatNumber } from "@/shared/utils/format";

const system = endpoints.domains.system;

type ConnectionTestKind = "clickhouse" | "text2sql-exec" | "text2sql-twin";

const connectionTests: ReadonlyArray<{ kind: ConnectionTestKind; label: string }> = [
  { kind: "clickhouse", label: "ClickHouse 연결 테스트" },
  { kind: "text2sql-exec", label: "Text2SQL 실행 DB 테스트" },
  { kind: "text2sql-twin", label: "Text2SQL 트윈 DB 테스트" },
];

function testEndpoint(kind: ConnectionTestKind) {
  if (kind === "clickhouse") return system.settings.testClickhouse;
  if (kind === "text2sql-exec") return system.settings.testText2sqlExec;
  return system.settings.testText2sqlTwin;
}

function createColumns(): ReadonlyArray<DataTableColumn<EffectiveSetting>> {
  const column = createDataTableColumnHelper<EffectiveSetting>();
  return column.columns([
    column.accessor((row) => row.key, {
      id: "key",
      header: "설정 키",
      cell: ({ row }) => (
        <div className="settings-key-cell">
          <span className="mono">{row.original.key}</span>
          {row.original.description ? <small>{row.original.description}</small> : null}
        </div>
      ),
    }),
    column.accessor((row) => row.category, { id: "category", header: "범주" }),
    column.accessor((row) => settingDisplayValue(row), {
      id: "value",
      header: "현재 값",
      cell: ({ row }) => <span className="mono truncate">{settingDisplayValue(row.original)}</span>,
    }),
    column.accessor((row) => settingSourceLabel(row.source), { id: "source", header: "적용 출처" }),
    column.display({
      id: "flags",
      header: "상태",
      cell: ({ row }) => (
        <span className="badge-list">
          {row.original.read_only ? <Badge tone="muted">읽기 전용</Badge> : null}
          {row.original.restart_required ? <Badge tone="warning">재시작 필요</Badge> : null}
          {row.original.is_secret ? <Badge tone="info">비밀값</Badge> : null}
        </span>
      ),
    }),
    column.accessor((row) => row.updated_at ?? "", {
      id: "updated_at",
      header: "마지막 변경",
      cell: ({ row }) => formatDateTime(row.original.updated_at),
    }),
  ]);
}

const settingColumns = createColumns();

export function RuntimeSettingsTab({ hasAdminWrite }: { hasAdminWrite: boolean }): React.JSX.Element {
  const [params, updateParams] = useSearchState();
  const settingsQuery = useEffectiveSettings();
  const triggerRef = useRef<HTMLElement | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | undefined>();
  const [confirm, setConfirm] = useState<
    { kind: "revert" | "rollback"; setting: EffectiveSetting } | undefined
  >();
  const [testResult, setTestResult] = useState<{ label: string; ok: boolean; detail: string } | undefined>();
  const [searchError, setSearchError] = useState<string | undefined>();

  const allSettings = useMemo(
    () => (settingsQuery.data?.settings ?? []).filter((setting) => !isConsoleSetting(setting)),
    [settingsQuery.data?.settings],
  );
  const categories = useMemo(() => settingCategories(allSettings), [allSettings]);
  const requestedCategory = params.get("category") ?? "";
  const category = categories.includes(requestedCategory) ? requestedCategory : "";
  const requestedQuery = params.get("q") ?? "";
  const query = containsPotentialSecret(requestedQuery) ? "" : requestedQuery;
  const rows = useMemo(
    () => filterSettings(allSettings, { category, query }),
    [allSettings, category, query],
  );
  const selected = allSettings.find((setting) => setting.key === selectedKey);

  const overrides = allSettings.filter((setting) => setting.source === "admin").length;
  const restartRequired = allSettings.filter((setting) => setting.restart_required).length;
  const readOnly = allSettings.filter((setting) => setting.read_only).length;
  const pod = settingsQuery.data?.this_pod;

  const saveSetting = useMutationFeedback({
    mutate: async (input: { setting: EffectiveSetting; value: string; reason: string }) => {
      const endpoint = system.settings.update;
      return apiClient.request(
        { ...endpoint, path: pathWithParams(endpoint.path, { key: input.setting.key }) },
        {
          body: {
            value: input.value,
            ...(input.reason ? { reason: input.reason } : {}),
            ...(input.setting.version === undefined ? {} : { expected_version: input.setting.version }),
          },
          routeId,
        },
      );
    },
    invalidates: [systemSettingsKeys.effective],
    successMessage: "설정을 저장했습니다.",
    errorMessage: "설정을 저장하지 못했습니다.",
  });

  const revertSetting = useMutationFeedback({
    mutate: async (input: { setting: EffectiveSetting; reason: string }) => {
      const endpoint = system.settings.revert;
      return apiClient.request(
        { ...endpoint, path: pathWithParams(endpoint.path, { key: input.setting.key }) },
        { query: { reason: input.reason }, routeId },
      );
    },
    invalidates: [systemSettingsKeys.effective],
    successMessage: "설정을 환경변수 기본값으로 되돌렸습니다.",
    errorMessage: "설정을 되돌리지 못했습니다.",
  });

  const rollbackSetting = useMutationFeedback({
    mutate: async (input: { setting: EffectiveSetting; reason: string }) =>
      apiClient.request(system.settings.rollback, {
        body: { key: input.setting.key, reason: input.reason },
        routeId,
      }),
    invalidates: [systemSettingsKeys.effective],
    successMessage: "설정을 이전 값으로 롤백했습니다.",
    errorMessage: "설정을 롤백하지 못했습니다.",
  });

  const runTest = useMutationFeedback({
    mutate: async (input: { kind: ConnectionTestKind; label: string }) =>
      apiClient.request(testEndpoint(input.kind), { routeId }),
    errorMessage: "연결 테스트를 실행하지 못했습니다.",
    onSuccess: (result, variables) => {
      const detail = [
        result.message,
        result.warning,
        result.driver ? `드라이버 ${result.driver}` : undefined,
        result.latency_ms === undefined ? undefined : `응답 ${formatNumber(result.latency_ms)}ms`,
        result.table_checked ? `테이블 ${result.table_checked}` : undefined,
      ]
        .filter(Boolean)
        .join(" · ");
      setTestResult({ label: variables.label, ok: result.ok === true, detail: detail || "결과 상세 없음" });
    },
  });

  const exportSettings = useMutationFeedback({
    mutate: async () => apiClient.request(system.settings.export, { routeId }),
    successMessage: "설정 백업 파일을 내려받았습니다.",
    errorMessage: "설정 백업을 만들지 못했습니다.",
    onSuccess: (result) => {
      const stamp = new Date().toISOString().slice(0, 10);
      downloadText(
        `settings-backup-${stamp}.json`,
        JSON.stringify(result, null, 2),
        "application/json;charset=utf-8",
      );
    },
  });

  const openSetting = useCallback((setting: EffectiveSetting): void => {
    triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSelectedKey(setting.key);
  }, []);

  const confirmPermission = confirm ? settingEditPermission(confirm.setting, hasAdminWrite) : undefined;

  return (
    <div className="settings-tab-stack">
      <StatGrid label="런타임 설정 요약">
        <StatCard label="설정 항목" value={formatNumber(allSettings.length)} />
        <StatCard label="DB 오버라이드" value={formatNumber(overrides)} tone="info" />
        <StatCard label="재시작 필요" value={formatNumber(restartRequired)} tone="warning" />
        <StatCard label="읽기 전용" value={formatNumber(readOnly)} />
      </StatGrid>

      {pod ? (
        <InlineNotice
          tone={pod.up_to_date === false ? "warning" : "success"}
          title={
            pod.up_to_date === false
              ? "이 파드는 아직 최신 설정을 적용하지 않았습니다."
              : "이 파드는 최신 설정을 적용했습니다."
          }
        >
          호스트 {pod.hostname || "—"} · 마지막 반영 {formatDateTime(pod.last_reload_at)} · 반영 주기{" "}
          {pod.reload_interval || "—"}
        </InlineNotice>
      ) : null}

      {settingsQuery.isError ? (
        <QueryNotice
          error={settingsQuery.error}
          hasPreviousData={Boolean(settingsQuery.data)}
          label="런타임 설정"
          onRetry={() => void settingsQuery.refetch()}
        />
      ) : null}

      <Toolbar
        label="런타임 설정 필터"
        end={
          <>
            <Button
              size="small"
              onClick={() => exportSettings.mutate(undefined)}
              disabled={exportSettings.isPending}
            >
              <Download aria-hidden="true" /> 설정 백업(JSON)
            </Button>
            <Button
              size="small"
              onClick={() => void settingsQuery.refetch()}
              disabled={settingsQuery.isFetching}
            >
              <RefreshCw aria-hidden="true" /> 새로고침
            </Button>
          </>
        }
      >
        <label className="settings-filter">
          <span>범주</span>
          <Select
            value={category}
            onChange={(event) => updateParams({ category: event.target.value || undefined })}
          >
            <option value="">전체 범주</option>
            {categories.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </Select>
        </label>
        <form
          className="settings-search"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            const submitted = new FormData(event.currentTarget).get("q");
            const next = typeof submitted === "string" ? submitted.trim() : "";
            if (containsPotentialSecret(next)) {
              setSearchError(secretSearchMessage);
              return;
            }
            setSearchError(undefined);
            updateParams({ q: next || undefined });
          }}
        >
          <label htmlFor="settings-search-input">설정 검색</label>
          <Input
            id="settings-search-input"
            name="q"
            key={query}
            defaultValue={query}
            placeholder="키, 설명, 범주"
            aria-invalid={searchError ? "true" : undefined}
            aria-describedby={searchError ? "settings-search-error" : undefined}
          />
          <Button size="small" type="submit">
            검색
          </Button>
          {searchError ? (
            <p id="settings-search-error" role="alert" className="field-error">
              {searchError}
            </p>
          ) : null}
        </form>
      </Toolbar>

      <section aria-label="연결 테스트" className="settings-test-row">
        {connectionTests.map((test) => (
          <Button
            key={test.kind}
            size="small"
            disabled={!hasAdminWrite || runTest.isPending}
            onClick={() => runTest.mutate(test)}
          >
            {test.label}
          </Button>
        ))}
        {!hasAdminWrite ? (
          <p className="settings-permission-note">연결 테스트에는 admin:write 권한이 필요합니다.</p>
        ) : null}
      </section>

      {testResult ? (
        <InlineNotice
          tone={testResult.ok ? "success" : "danger"}
          title={`${testResult.label} ${testResult.ok ? "성공" : "실패"}`}
        >
          {testResult.detail}
        </InlineNotice>
      ) : null}

      {!settingsQuery.isPending && rows.length === 0 ? (
        <EmptyState
          title="조건에 맞는 설정이 없습니다."
          description="범주나 검색어를 바꾸면 게이트웨이가 제공하는 런타임 설정 목록을 볼 수 있습니다."
          actions={
            <Button size="small" onClick={() => updateParams({ category: undefined, q: undefined })}>
              필터 초기화
            </Button>
          }
        />
      ) : (
        <DataTable
          caption="런타임 설정 목록"
          columns={settingColumns}
          data={rows}
          getRowActionLabel={(row) => `${row.key} 설정 열기`}
          getRowId={(row) => row.key}
          loading={settingsQuery.isPending}
          onRowClick={openSetting}
          emptyMessage="표시할 설정이 없습니다."
        />
      )}
      <UpdatedAt at={settingsQuery.dataUpdatedAt} />

      <SettingDetailSheet
        hasAdminWrite={hasAdminWrite}
        open={selected !== undefined}
        onOpenChange={(next) => {
          if (!next) setSelectedKey(undefined);
        }}
        onRequestRevert={(setting) => {
          setSelectedKey(undefined);
          setConfirm({ kind: "revert", setting });
        }}
        onRequestRollback={(setting) => {
          setSelectedKey(undefined);
          setConfirm({ kind: "rollback", setting });
        }}
        onSave={(input) => saveSetting.mutateAsync(input)}
        pending={saveSetting.isPending}
        returnFocusRef={triggerRef}
        setting={selected}
      />

      <ConfirmDialog
        open={confirm !== undefined}
        onOpenChange={(next) => {
          if (!next) setConfirm(undefined);
        }}
        title={confirm?.kind === "rollback" ? "이전 값으로 롤백" : "환경변수 기본값으로 되돌리기"}
        description={
          confirm?.kind === "rollback"
            ? `${confirm.setting.key} 설정을 이력의 직전 값으로 되돌립니다.`
            : `${confirm?.setting.key ?? ""} 설정의 DB 오버라이드를 지우고 환경변수 값을 사용합니다.`
        }
        confirmLabel={confirm?.kind === "rollback" ? "롤백" : "되돌리기"}
        tone="danger"
        requireReason
        returnFocusRef={triggerRef}
        onConfirm={async (reason) => {
          if (!confirm || confirmPermission?.editable !== true) return;
          if (confirm.kind === "rollback") {
            await rollbackSetting.mutateAsync({ setting: confirm.setting, reason });
          } else {
            await revertSetting.mutateAsync({ setting: confirm.setting, reason });
          }
        }}
      >
        {confirmPermission && !confirmPermission.editable ? (
          <p className="form-error" role="alert">
            {confirmPermission.reason}
          </p>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}
