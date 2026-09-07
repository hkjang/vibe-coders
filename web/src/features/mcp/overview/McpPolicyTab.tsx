import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useRef, useState } from "react";
import { z } from "zod";

import { QueryNotice } from "@/features/mcp/mcp-ui";
import { decisionLabel, decisionTone, riskTone } from "@/features/mcp/mcp-utils";
import { apiClient } from "@/shared/api/client";
import type { McpPolicyBody } from "@/shared/api/domains/mcp";
import type { McpPolicy } from "@/shared/api/domains/mcp.schemas";
import { withPathParams } from "@/shared/api/endpoint-factory";
import { endpoints } from "@/shared/api/endpoints";
import { FormDialog } from "@/shared/components/form/FormDialog";
import { FormField } from "@/shared/components/form/FormField";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { Input } from "@/shared/components/ui/Input";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { Switch } from "@/shared/components/ui/Switch";
import { Textarea } from "@/shared/components/ui/Textarea";
import { Toolbar } from "@/shared/components/ui/Toolbar";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import { DataTable } from "@/shared/data-table/DataTable";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { formatDateTime, formatNumber } from "@/shared/utils/format";

const routeId = "mcp.overview";

const modeOptions = [
  { value: "allow", label: "allow (허용)" },
  { value: "warn", label: "warn (경고)" },
  { value: "block", label: "block (차단)" },
];

const policyFormSchema = z.object({
  server_label: z.string().trim().min(1, "서버 라벨을 입력하세요."),
  mode: z.enum(["allow", "warn", "block"]),
  note: z.string(),
});
type PolicyFormValues = z.infer<typeof policyFormSchema>;

const policyColumn = createDataTableColumnHelper<McpPolicy>();

interface LoopRow {
  session_id: string;
  server_label: string;
  tool_name: string;
  calls: number;
  errors: number;
  api_key_id: string;
  last_seen: string;
}
const loopColumn = createDataTableColumnHelper<LoopRow>();
const loopColumns = [
  loopColumn.accessor((row) => row.session_id, {
    id: "session",
    header: "세션",
    cell: (info) => <span className="mono truncate">{info.getValue<string>() || "—"}</span>,
  }),
  loopColumn.accessor((row) => `${row.server_label}/${row.tool_name}`, {
    id: "tool",
    header: "서버/도구",
    cell: (info) => <span className="mono">{info.getValue<string>()}</span>,
  }),
  loopColumn.accessor((row) => formatNumber(row.calls), { id: "calls", header: "호출" }),
  loopColumn.accessor((row) => formatNumber(row.errors), { id: "errors", header: "오류" }),
  loopColumn.accessor((row) => row.api_key_id || "—", { id: "key", header: "API 키" }),
  loopColumn.accessor((row) => formatDateTime(row.last_seen), { id: "last", header: "최근" }),
] as ReadonlyArray<DataTableColumn<LoopRow>>;

export function McpPolicyTab({ canWrite }: { canWrite: boolean }): React.JSX.Element {
  const [formOpen, setFormOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<McpPolicy | undefined>();
  const [lookup, setLookup] = useState<{ server: string; tool: string }>({ server: "", tool: "" });
  const [submitted, setSubmitted] = useState<{ server: string; tool: string } | undefined>();
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const tableRef = useRef<HTMLElement>(null);

  const form = useZodForm(policyFormSchema, { server_label: "", mode: "allow", note: "" });

  const policies = useQuery({
    queryKey: ["mcp", "policies"],
    queryFn: ({ signal }) => apiClient.request(endpoints.domains.mcp.policies, { signal, routeId }),
  });
  const loops = useQuery({
    queryKey: ["mcp", "loops"],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.mcp.loops, {
        query: { window: "24h", threshold: 10, limit: 50 },
        signal,
        routeId,
      }),
  });
  const effective = useQuery({
    queryKey: ["mcp", "effective-policy", submitted?.server, submitted?.tool],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.mcp.effectivePolicy, {
        query: {
          server: submitted?.server ?? "",
          ...(submitted?.tool ? { tool: submitted.tool } : {}),
        },
        signal,
        routeId,
      }),
    enabled: Boolean(submitted?.server),
  });

  const savePolicy = useMutationFeedback({
    mutate: (body: McpPolicyBody) => apiClient.request(endpoints.domains.mcp.savePolicy, { body, routeId }),
    invalidates: [["mcp"]],
    successMessage: "정책을 저장했습니다.",
    errorMessage: "정책을 저장하지 못했습니다.",
  });
  const removePolicy = useMutationFeedback({
    mutate: (server: string) =>
      apiClient.request(withPathParams(endpoints.domains.mcp.deletePolicy, { server }), { routeId }),
    invalidates: [["mcp"]],
    successMessage: "정책을 삭제했습니다.",
    errorMessage: "정책을 삭제하지 못했습니다.",
  });

  const policyColumns = [
    policyColumn.accessor((row) => row.server_label, {
      id: "server",
      header: "서버 라벨",
      cell: (info) => <span className="mono">{info.getValue<string>()}</span>,
    }),
    policyColumn.accessor((row) => row.mode, {
      id: "mode",
      header: "모드",
      cell: (info) => (
        <Badge tone={decisionTone(info.getValue<string>())}>{decisionLabel(info.getValue<string>())}</Badge>
      ),
    }),
    policyColumn.accessor((row) => row.note || "—", { id: "note", header: "메모" }),
    policyColumn.accessor((row) => formatDateTime(row.updated_at), { id: "updated", header: "수정" }),
    policyColumn.display({
      id: "actions",
      header: "작업",
      cell: (info) => (
        <Button
          size="small"
          variant="danger"
          disabled={!canWrite}
          title={canWrite ? undefined : "mcp:admin 권한이 필요합니다."}
          onClick={() => setDeleteTarget(info.row.original)}
        >
          삭제
        </Button>
      ),
    }),
  ] as ReadonlyArray<DataTableColumn<McpPolicy>>;

  const allowlistEnabled = policies.data?.allowlist_enabled ?? false;
  const effectivePolicy = effective.data?.policy;
  const effectiveFinal = effective.data?.final;

  return (
    <div className="mcp-section-stack">
      {policies.isError ? (
        <QueryNotice
          error={policies.error}
          hasData={Boolean(policies.data)}
          label="MCP 정책"
          onRetry={() => void policies.refetch()}
        />
      ) : null}

      <SectionCard
        title="서버 정책"
        description="서버 라벨 단위로 MCP 도구 호출을 허용·경고·차단합니다."
        actions={
          <Toolbar
            label="정책 작업"
            end={
              <Button
                ref={createButtonRef}
                variant="primary"
                disabled={!canWrite}
                title={canWrite ? undefined : "mcp:admin 권한이 필요합니다."}
                onClick={() => {
                  form.reset({ server_label: "", mode: "allow", note: "" });
                  setFormOpen(true);
                }}
              >
                <Plus aria-hidden="true" /> 정책 추가
              </Button>
            }
          >
            <Switch
              checked={allowlistEnabled}
              disabled={!canWrite || savePolicy.isPending}
              label="허용목록 모드 (등록된 서버만 허용)"
              onCheckedChange={(checked) => savePolicy.mutate({ allowlist_enabled: checked })}
            />
          </Toolbar>
        }
      >
        {!policies.isPending && (policies.data?.policies.length ?? 0) === 0 ? (
          <EmptyState
            title="등록된 서버 정책이 없습니다."
            description="정책을 추가하면 해당 서버의 도구 호출을 차단하거나 경고로 표시할 수 있습니다."
          />
        ) : (
          <DataTable
            caption="MCP 서버 정책"
            columns={policyColumns}
            data={policies.data?.policies ?? []}
            loading={policies.isPending}
            getRowId={(row) => row.server_label}
          />
        )}
      </SectionCard>

      <SectionCard
        title="실효 정책 조회"
        description="서버와 도구를 입력하면 최종 판단(허용·경고·승인·차단)과 근거를 보여 줍니다."
      >
        <form
          className="mcp-inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (lookup.server.trim() === "") return;
            setSubmitted({ server: lookup.server.trim(), tool: lookup.tool.trim() });
          }}
        >
          <label htmlFor="mcp-eff-server">
            서버 라벨
            <Input
              id="mcp-eff-server"
              value={lookup.server}
              required
              onChange={(event) => setLookup((prev) => ({ ...prev, server: event.target.value }))}
            />
          </label>
          <label htmlFor="mcp-eff-tool">
            도구 이름 (선택)
            <Input
              id="mcp-eff-tool"
              value={lookup.tool}
              onChange={(event) => setLookup((prev) => ({ ...prev, tool: event.target.value }))}
            />
          </label>
          <Button type="submit" variant="primary" disabled={effective.isFetching}>
            {effective.isFetching ? "조회 중" : "조회"}
          </Button>
        </form>
        {effective.isError ? (
          <QueryNotice
            error={effective.error}
            hasData={false}
            label="실효 정책"
            onRetry={() => void effective.refetch()}
          />
        ) : null}
        {effective.data ? (
          <KeyValueList
            items={[
              { label: "서버", value: effective.data.server, mono: true },
              { label: "도구", value: effective.data.tool || "(서버 전체)", mono: true },
              { label: "서버 정책", value: decisionLabel(effectivePolicy?.server_policy ?? "") },
              { label: "허용목록", value: effectivePolicy?.allowlist_enabled ? "사용" : "미사용" },
              {
                label: "도구 위험도",
                value: effectivePolicy?.tool_risk_level ? (
                  <Badge tone={riskTone(effectivePolicy.tool_risk_level)}>
                    {effectivePolicy.tool_risk_level}
                  </Badge>
                ) : (
                  "—"
                ),
              },
              { label: "도구 조치", value: decisionLabel(effectivePolicy?.tool_risk_action ?? "") },
              {
                label: "최종 판단",
                value: effectiveFinal ? (
                  <Badge tone={decisionTone(effectiveFinal.decision)}>
                    {decisionLabel(effectiveFinal.decision)}
                  </Badge>
                ) : (
                  "—"
                ),
              },
              { label: "근거", value: effectiveFinal?.reason || "—" },
            ]}
          />
        ) : null}
      </SectionCard>

      <SectionCard
        title="에이전트 루프 의심"
        description="최근 24시간 동안 한 세션에서 같은 도구를 10회 이상 호출한 사례입니다."
      >
        {loops.isError ? (
          <QueryNotice
            error={loops.error}
            hasData={Boolean(loops.data)}
            label="에이전트 루프"
            onRetry={() => void loops.refetch()}
          />
        ) : null}
        <DataTable
          caption="에이전트 루프 의심 세션"
          columns={loopColumns}
          data={loops.data?.loops ?? []}
          loading={loops.isPending}
          getRowId={(row, index) => `${row.session_id}:${row.tool_name}:${index}`}
          emptyMessage="루프로 의심되는 호출이 없습니다."
        />
      </SectionCard>

      <FormDialog
        form={form}
        open={formOpen}
        onOpenChange={setFormOpen}
        returnFocusRef={createButtonRef}
        title="MCP 서버 정책 추가"
        description="서버 라벨 단위로 도구 호출 정책을 저장합니다."
        onSubmit={async (values: PolicyFormValues) => {
          await savePolicy.mutateAsync({
            server_label: values.server_label,
            mode: values.mode,
            note: values.note.trim(),
          });
        }}
      >
        <FormField label="서버 라벨" required error={form.formState.errors.server_label?.message}>
          {(control) => <Input {...control} {...form.register("server_label")} />}
        </FormField>
        <FormField label="모드" required error={form.formState.errors.mode?.message}>
          {(control) => <Select {...control} {...form.register("mode")} options={modeOptions} />}
        </FormField>
        <FormField label="메모" error={form.formState.errors.note?.message}>
          {(control) => <Textarea {...control} {...form.register("note")} rows={2} />}
        </FormField>
      </FormDialog>

      <ConfirmDialog
        open={deleteTarget !== undefined}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(undefined);
        }}
        returnFocusRef={tableRef}
        tone="danger"
        title="정책을 삭제할까요?"
        description={`${deleteTarget?.server_label ?? ""} 서버 정책이 사라지고 기본 규칙이 적용됩니다.`}
        confirmLabel="삭제"
        onConfirm={async () => {
          if (!deleteTarget) return;
          await removePolicy.mutateAsync(deleteTarget.server_label);
          setDeleteTarget(undefined);
        }}
      />
    </div>
  );
}
