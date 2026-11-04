import { useState, type RefObject } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useAuth } from "@/app/auth/AuthProvider";
import { decisionLabel } from "@/features/mcp/mcp-utils";
import {
  actionChoices,
  riskChanges,
  riskFormSchema,
  riskLevelChoices,
  riskSnapshot,
  type RiskDraft,
} from "./tool-risk-review";
import { apiClient } from "@/shared/api/client";
import { AppError } from "@/shared/api/error";
import type { McpToolRisk } from "@/shared/api/domains/mcp.schemas";
import { endpoints } from "@/shared/api/endpoints";
import { tokenStore } from "@/shared/auth/token-store";
import { FormDialog } from "@/shared/components/form/FormDialog";
import { FormField } from "@/shared/components/form/FormField";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Select } from "@/shared/components/ui/Select";
import { Textarea } from "@/shared/components/ui/Textarea";
import { useFeatureMutationAccess } from "@/shared/feature-access/use-feature-mutation-access";
import {
  assertFeatureRead,
  featureOwnedKey,
  type FeatureReadOwner,
} from "@/shared/hooks/use-feature-read-owner";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";

const flights = new WeakMap<QueryClient, Set<string>>();

export function ToolRiskDialog({
  baseline,
  owner,
  canWrite,
  onClose,
  returnFocusRef,
}: {
  baseline: McpToolRisk;
  owner: FeatureReadOwner;
  canWrite: boolean;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}) {
  const auth = useAuth();
  const client = useQueryClient();
  const write = useFeatureMutationAccess(
    ["mcp.overview"],
    canWrite && auth.user?.scopes.includes("mcp:admin") === true,
    "MCP 관리 권한(mcp:admin)이 필요합니다.",
  );
  const key = JSON.stringify([tokenStore.getSessionEpoch(), auth.mode, auth.user?.id]);
  const assertCurrent = () => {
    assertFeatureRead(owner);
    write.assertCurrent();
  };
  const [conflict, setConflict] = useState(false);
  const form = useZodForm<RiskDraft, RiskDraft>(riskFormSchema, {
    risk_level: baseline.risk_level,
    action: baseline.action,
    note: baseline.note,
  });
  const draft = form.watch();
  const changes = riskChanges(baseline, draft);
  const valid = riskFormSchema.safeParse(draft).success;
  const save = useMutationFeedback({
    gcTime: 0,
    ownsResult: () => {
      try {
        assertCurrent();
        return true;
      } catch {
        return false;
      }
    },
    invalidates: [
      ["mcp", "tools"],
      ["mcp", "trust-scores"],
      ["mcp", "overview"],
      ["mcp", "topology"],
    ],
    successMessage: "도구 위험 등급을 저장했습니다.",
    errorMessage: "도구 위험 등급을 저장하지 못했습니다.",
    mutate: async (values: RiskDraft) => {
      assertCurrent();
      let active = flights.get(client);
      if (!active) {
        active = new Set();
        flights.set(client, active);
      }
      if (active.has(key))
        throw new AppError("현재 계정의 도구 위험 설정을 저장 중입니다.", { kind: "aborted" });
      active.add(key);
      try {
        const latest = await client.fetchQuery({
          queryKey: featureOwnedKey(
            ["mcp", "tools", "risk-preflight", baseline.server_label, baseline.tool_name],
            owner,
          ),
          gcTime: 0,
          staleTime: 0,
          retry: false,
          queryFn: async ({ signal }) => {
            assertFeatureRead(owner, signal);
            const data = await apiClient.request(endpoints.domains.mcp.tools, {
              query: { server: baseline.server_label, tool: baseline.tool_name, limit: 200 },
              routeId: "mcp.overview",
              retryUnauthorized: false,
              signal,
            });
            assertFeatureRead(owner, signal);
            return data;
          },
        });
        assertCurrent();
        const current = latest.tool_risk.find(
          (row) => row.server_label === baseline.server_label && row.tool_name === baseline.tool_name,
        );
        if (!current || riskSnapshot(current) !== riskSnapshot(baseline)) {
          setConflict(true);
          throw new AppError(
            "도구 설정이 변경되었거나 현재 목록에서 확인되지 않습니다. 창을 닫고 새로고침한 뒤 다시 검토하세요.",
            { kind: "http", status: 409 },
          );
        }
        assertCurrent();
        return await apiClient.request(endpoints.domains.mcp.saveToolRisk, {
          body: {
            server_label: baseline.server_label,
            tool_name: baseline.tool_name,
            risk_level: values.risk_level,
            action: values.action,
            note: values.note.trim(),
          },
          routeId: "mcp.overview",
          retryUnauthorized: false,
        });
      } finally {
        active.delete(key);
      }
    },
  });
  const disabled = !write.allowed || conflict || !valid || changes.length === 0;
  return (
    <FormDialog
      form={form}
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      returnFocusRef={returnFocusRef}
      title="도구 위험 등급"
      description={`${baseline.server_label} / ${baseline.tool_name}의 변경 전후를 검토합니다.`}
      scrollBody
      submitLabel="검토한 변경 저장"
      submitDisabled={disabled}
      onSubmit={async (values) => {
        assertCurrent();
        await save.mutateAsync(values);
        assertCurrent();
        onClose();
      }}
    >
      {!write.allowed ? (
        <InlineNotice tone="warning" title="지금은 저장할 수 없습니다.">
          {write.reason} 입력한 내용은 유지합니다.
        </InlineNotice>
      ) : null}
      {conflict ? (
        <InlineNotice tone="warning" title="현재 설정을 다시 확인하세요.">
          입력을 보존했습니다. 창을 닫고 목록을 새로고침한 뒤 다시 검토하세요.
        </InlineNotice>
      ) : null}
      {!baseline.configured ? (
        <p>
          지금은 접근 유형({baseline.access_class || "미분류"})에서 추론한 기본값입니다. 저장하면 이 도구에
          고정됩니다.
        </p>
      ) : null}
      <FormField label="위험 등급" required error={form.formState.errors.risk_level?.message}>
        {(control) => (
          <Select {...control} {...form.register("risk_level")} options={riskLevelChoices}>
            {!riskLevelChoices.some((item) => item.value === baseline.risk_level) ? (
              <option value={baseline.risk_level}>
                지원하지 않는 현재 값: {baseline.risk_level || "미지정"}
              </option>
            ) : null}
          </Select>
        )}
      </FormField>
      <FormField
        label="조치"
        required
        description={
          baseline.recommended_action ? `권장 조치: ${decisionLabel(baseline.recommended_action)}` : undefined
        }
        error={form.formState.errors.action?.message}
      >
        {(control) => (
          <Select {...control} {...form.register("action")} options={actionChoices}>
            {!actionChoices.some((item) => item.value === baseline.action) ? (
              <option value={baseline.action}>지원하지 않는 현재 값: {baseline.action || "미지정"}</option>
            ) : null}
          </Select>
        )}
      </FormField>
      {!valid ? (
        <p role="status">
          지원하는 위험 등급·조치를 명시적으로 선택하고 메모 길이를 확인하세요. 알 수 없는 현재 값은 자동으로
          낮추거나 허용하지 않습니다.
        </p>
      ) : null}
      <FormField label="메모" error={form.formState.errors.note?.message}>
        {(control) => <Textarea {...control} rows={2} {...form.register("note")} />}
      </FormField>
      <section aria-label="도구 위험 설정 변경 비교" className="mcp-risk-review">
        <h3>저장할 변경 내용</h3>
        {changes.length ? (
          <dl>
            {changes.map((change) => (
              <div key={change.id}>
                <dt>{change.label}</dt>
                <dd>
                  <span>변경 전: {change.before}</span>
                  <br />
                  <span>변경 후: {change.after}</span>
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <p>변경된 항목이 없습니다.</p>
        )}
        <p>
          편집을 시작한 값과 비교합니다. 저장하면 이 서버·도구의 이후 호출 처리에 영향을 줄 수 있습니다. 실제
          영향 대상과 실행 중인 호출의 상태는 확인하지 않습니다. 저장 직전 값을 다시 조회하지만 다른 관리자의
          동시 변경을 잠그지는 않습니다.
        </p>
      </section>
    </FormDialog>
  );
}
