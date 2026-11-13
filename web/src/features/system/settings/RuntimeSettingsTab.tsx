import { connectionTests, testEndpoint, type ConnectionTestKind } from "./runtime-connection-tests";
import { settingColumns } from "./runtime-setting-columns";
import { RuntimeSettingUnavailable } from "./RuntimeSettingUnavailable";
import { Download, RefreshCw } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { QueryNotice, UpdatedAt } from "@/features/system/settings/SettingsParts";
import { SettingDetailSheet } from "@/features/system/settings/SettingDetailSheet";
import { useSettingSaveOutcome } from "@/features/system/settings/setting-save-outcome";
import type { SettingRecovery } from "./SettingsRecoveryDialog";
import { LazySettingsRecovery } from "./LazySettingsRecovery";
import {
  filterSettings,
  isConsoleSetting,
  settingCategories,
  settingEditPermission,
  settingWithCurrentPermission,
  runtimeSettingKeyValid,
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
import { Button } from "@/shared/components/ui/Button";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { Select } from "@/shared/components/ui/Select";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { Toolbar } from "@/shared/components/ui/Toolbar";
import { DataTable } from "@/shared/data-table/DataTable";
import { useSettingsMutation, useSettingsWriteAccess } from "./use-settings-mutation";
import { useSettingsWorkspace } from "./settings-workspace-context";
import { useSettingsReloadNotice } from "@/features/system/settings/use-settings-reload-notice";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { containsPotentialSecret, secretSearchMessage } from "@/shared/security/secrets";
import { downloadText } from "@/shared/utils/csv";
import { formatDateTime, formatNumber } from "@/shared/utils/format";

const system = endpoints.domains.system;

export function RuntimeSettingsTab({ hasAdminWrite }: { hasAdminWrite: boolean }): React.JSX.Element {
  const [params, updateParams] = useSearchState();
  const settingsQuery = useEffectiveSettings();
  const triggerRef = useRef<HTMLElement | null>(null);
  const selectedKey = params.get("setting") ?? "";
  const validSelectedKey = runtimeSettingKeyValid(selectedKey);
  const [confirm, setConfirm] = useState<SettingRecovery | undefined>();
  const { owner, principal, effectiveKey, scopedWriter } = useSettingsWorkspace();
  const access = useSettingsWriteAccess();
  const { reloadPending, setReloadPending } = useSettingsReloadNotice({
    effectiveKey,
    principal,
    isCurrent: owner.isCurrent,
  });
  const settingSaveOutcome = useSettingSaveOutcome(effectiveKey);
  const [testResult, setTestResult] = useState<{ label: string; ok: boolean; detail: string } | undefined>();
  const [searchError, setSearchError] = useState<string | undefined>();

  const allSettings = useMemo(
    () => (settingsQuery.data?.settings ?? []).filter((setting) => !isConsoleSetting(setting)),
    [settingsQuery.data?.settings],
  );
  const selected = validSelectedKey ? allSettings.find((row) => row.key === selectedKey) : undefined;
  const categories = useMemo(() => settingCategories(allSettings), [allSettings]);
  const requestedCategory = params.get("category") ?? "";
  const category = categories.includes(requestedCategory) ? requestedCategory : "";
  const requestedQuery = params.get("q") ?? "";
  const query = containsPotentialSecret(requestedQuery) ? "" : requestedQuery;
  const rows = useMemo(
    () => filterSettings(allSettings, { category, query }),
    [allSettings, category, query],
  );

  const overrides = allSettings.filter((setting) => setting.source === "admin").length;
  const restartRequired = allSettings.filter((setting) => setting.restart_required).length;
  const readOnly = allSettings.filter((setting) => setting.read_only).length;
  const pod = settingsQuery.data?.this_pod;

  const saveSetting = useSettingsMutation({
    authorized: hasAdminWrite || scopedWriter,
    mutate: async (input: { setting: EffectiveSetting; value: string; reason: string }) => {
      if (!settingEditPermission(input.setting, hasAdminWrite, access.allowed, scopedWriter).editable)
        throw new Error("이 설정을 변경할 권한이 없습니다.");
      const endpoint = system.settings.update;
      return settingSaveOutcome(() =>
        apiClient.request(
          { ...endpoint, path: pathWithParams(endpoint.path, { key: input.setting.key }) },
          {
            body: {
              value: input.value,
              ...(input.reason ? { reason: input.reason } : {}),
              expected_version: input.setting.version ?? 0,
            },
            routeId,
          },
        ),
      );
    },
    invalidates: [systemSettingsKeys.effective],
    onSuccess: (result) => {
      if (result.outcome === "reload_pending") setReloadPending(result);
      else if (result.outcome === "saved") {
        setReloadPending(undefined);
        toast.success("설정을 저장했습니다.");
      }
    },
    errorMessage: "설정을 저장하지 못했습니다.",
  });

  const runTest = useSettingsMutation({
    authorized: hasAdminWrite,
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

  const exportSettings = useSettingsMutation({
    readOnly: true,
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

  const openSetting = useCallback(
    (setting: EffectiveSetting): void => {
      triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      updateParams({ setting: setting.key }, { replace: false });
    },
    [updateParams],
  );

  return (
    <div
      className="settings-tab-stack"
      onClickCapture={(event) => {
        const link =
          event.target instanceof Element ? event.target.closest<HTMLElement>("a[data-setting-link]") : null;
        if (link) triggerRef.current = link;
      }}
    >
      {!access.allowed ? (
        <InlineNotice tone="info" title="읽기 전용으로 전환됐습니다.">
          {access.reason} 입력한 초안은 유지됩니다.
        </InlineNotice>
      ) : !hasAdminWrite && scopedWriter ? (
        <InlineNotice tone="info" title="설정별 변경 권한을 적용합니다.">
          현재 계정에 서버가 허용한 범주의 설정만 변경할 수 있습니다.
        </InlineNotice>
      ) : !hasAdminWrite ? (
        <InlineNotice tone="info" title="변경 권한이 없습니다.">
          설정 조회만 가능합니다. 변경에는 admin:write 권한이 필요합니다.
        </InlineNotice>
      ) : null}
      {reloadPending ? (
        <InlineNotice tone="warning" title="설정은 저장됐으며 런타임 반영을 기다리고 있습니다.">
          다시 저장하지 말고 최신 설정과 서버 반영 상태를 확인하세요.
          {reloadPending.requestId ? (
            <span className="request-id"> 요청 ID: {reloadPending.requestId}</span>
          ) : null}
        </InlineNotice>
      ) : null}
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
            disabled={!hasAdminWrite || !access.allowed || runTest.isPending}
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

      {selectedKey && !selected ? (
        <RuntimeSettingUnavailable
          loading={settingsQuery.isPending}
          error={settingsQuery.error}
          valid={validSelectedKey}
          onClose={() => updateParams({ setting: undefined })}
          onRetry={() => void settingsQuery.refetch()}
          returnFocusRef={triggerRef}
        />
      ) : null}
      <SettingDetailSheet
        hasAdminWrite={hasAdminWrite}
        featureWritable={access.allowed && !settingsQuery.isError}
        open={selected !== undefined}
        onOpenChange={(next) => {
          if (!next) updateParams({ setting: undefined });
        }}
        onRequestRevert={(setting) => {
          updateParams({ setting: undefined });
          setConfirm({ kind: "revert", setting });
        }}
        onRequestRollback={(setting, historyId, historyCount) => {
          updateParams({ setting: undefined });
          setConfirm({ kind: "rollback", setting, historyId, historyCount });
        }}
        onSave={async (input) => {
          const result = await saveSetting.mutateAsync(input);
          if (result.outcome === "conflict") throw result.error;
        }}
        pending={saveSetting.isPending}
        returnFocusRef={triggerRef}
        setting={selected}
      />

      <LazySettingsRecovery
        request={
          confirm
            ? { ...confirm, setting: settingWithCurrentPermission(confirm.setting, allSettings) }
            : undefined
        }
        onClose={() => setConfirm(undefined)}
        hasAdminWrite={hasAdminWrite}
        featureWritable={access.allowed && !settingsQuery.isError}
        onReloadPending={setReloadPending}
        onSaved={() => setReloadPending(undefined)}
        returnFocusRef={triggerRef}
      />
    </div>
  );
}
