import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, RefreshCw } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { z } from "zod";

import { useAuth } from "@/app/auth/AuthProvider";
import "@/features/mcp/mcp.css";
import { QueryNotice } from "@/features/mcp/mcp-ui";
import { riskTone } from "@/features/mcp/mcp-utils";
import { apiClient } from "@/shared/api/client";
import type { McpContractBody } from "@/shared/api/domains/mcp";
import type { McpContract } from "@/shared/api/domains/mcp.schemas";
import { endpoints } from "@/shared/api/endpoints";
import { FormDialog } from "@/shared/components/form/FormDialog";
import { FormField } from "@/shared/components/form/FormField";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { PageHeader } from "@/shared/components/page/PageHeader";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { Checkbox } from "@/shared/components/ui/Checkbox";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { JsonBlock } from "@/shared/components/ui/JsonBlock";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { Textarea } from "@/shared/components/ui/Textarea";
import { Toolbar } from "@/shared/components/ui/Toolbar";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import { DataTable } from "@/shared/data-table/DataTable";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { formatNumber } from "@/shared/utils/format";

const routeId = "mcp.gateway";
const writeScope = "mcp:admin";

const riskOptions = [
  { value: "low", label: "low" },
  { value: "medium", label: "medium" },
  { value: "high", label: "high" },
];

const contractFormSchema = z.object({
  id: z.string(),
  namespace: z.string().trim(),
  name: z.string().trim().min(1, "도구 이름을 입력하세요."),
  title: z.string(),
  description: z.string(),
  risk_level: z.enum(["low", "medium", "high"]),
  timeout_ms: z
    .string()
    .trim()
    .refine((value) => value === "" || /^\d+$/u.test(value), "0 이상의 정수를 입력하세요."),
  allowed_roles: z.string(),
  cost_policy: z.string(),
  owner: z.string(),
  input_schema: z.string().refine((value) => {
    if (value.trim() === "") return true;
    try {
      JSON.parse(value);
      return true;
    } catch {
      return false;
    }
  }, "올바른 JSON을 입력하세요."),
  enabled: z.boolean(),
});
type ContractFormValues = z.infer<typeof contractFormSchema>;

const emptyContract: ContractFormValues = {
  id: "",
  namespace: "gateway",
  name: "",
  title: "",
  description: "",
  risk_level: "low",
  timeout_ms: "",
  allowed_roles: "",
  cost_policy: "",
  owner: "",
  input_schema: "",
  enabled: true,
};

interface GatewayToolRow {
  name: string;
  description: string;
}
const toolColumn = createDataTableColumnHelper<GatewayToolRow>();
const toolColumns = [
  toolColumn.accessor((row) => row.name, {
    id: "name",
    header: "도구",
    cell: (info) => <span className="mono">{info.getValue<string>()}</span>,
  }),
  toolColumn.accessor((row) => row.description || "—", { id: "description", header: "설명" }),
] as ReadonlyArray<DataTableColumn<GatewayToolRow>>;

interface GatewayContractRow {
  name: string;
  risk_level: string;
  cost_policy: string;
  timeout_ms: number;
  allowed_roles: string;
  executes: boolean;
  output_schema: string;
}
const publishedColumn = createDataTableColumnHelper<GatewayContractRow>();
const publishedColumns = [
  publishedColumn.accessor((row) => row.name, {
    id: "name",
    header: "도구",
    cell: (info) => <span className="mono">{info.getValue<string>()}</span>,
  }),
  publishedColumn.accessor((row) => row.risk_level, {
    id: "risk",
    header: "위험도",
    cell: (info) => <Badge tone={riskTone(info.getValue<string>())}>{info.getValue<string>()}</Badge>,
  }),
  publishedColumn.accessor((row) => row.cost_policy, { id: "cost", header: "비용 정책" }),
  publishedColumn.accessor((row) => `${formatNumber(row.timeout_ms)}ms`, {
    id: "timeout",
    header: "타임아웃",
  }),
  publishedColumn.accessor((row) => (row.executes ? "실행" : "읽기 전용"), {
    id: "executes",
    header: "동작",
  }),
  publishedColumn.accessor((row) => row.output_schema, { id: "output", header: "출력 형태" }),
] as ReadonlyArray<DataTableColumn<GatewayContractRow>>;

interface ValidationRow {
  contract_id: string;
  namespace: string;
  name: string;
  status: string;
  detail: string;
  declared_only: string[];
  live_only: string[];
}
const validationColumn = createDataTableColumnHelper<ValidationRow>();
const validationColumns = [
  validationColumn.accessor((row) => row.name, {
    id: "name",
    header: "도구",
    cell: (info) => <span className="mono">{info.getValue<string>()}</span>,
  }),
  validationColumn.accessor((row) => row.namespace, { id: "namespace", header: "네임스페이스" }),
  validationColumn.accessor((row) => row.status, {
    id: "status",
    header: "결과",
    cell: (info) => {
      const status = info.getValue<string>();
      return (
        <Badge tone={status === "ok" ? "success" : status === "missing" ? "danger" : "warning"}>
          {status}
        </Badge>
      );
    },
  }),
  validationColumn.accessor((row) => row.detail, { id: "detail", header: "설명" }),
  validationColumn.accessor(
    (row) =>
      [
        row.declared_only.length > 0 ? `계약에만: ${row.declared_only.join(", ")}` : "",
        row.live_only.length > 0 ? `실제에만: ${row.live_only.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join(" / ") || "—",
    { id: "diff", header: "스키마 차이" },
  ),
] as ReadonlyArray<DataTableColumn<ValidationRow>>;

export function GatewayMcpPage(): React.JSX.Element {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const canWrite = auth.user?.scopes.includes(writeScope) ?? false;
  const [formOpen, setFormOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<McpContract | undefined>();
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const tableRef = useRef<HTMLElement>(null);

  const form = useZodForm(contractFormSchema, emptyContract);

  const info = useQuery({
    queryKey: ["mcp", "gateway", "info"],
    queryFn: ({ signal }) => apiClient.request(endpoints.domains.mcp.gateway.info, { signal, routeId }),
  });
  const contracts = useQuery({
    queryKey: ["mcp", "gateway", "contracts"],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.mcp.gateway.contracts, { query: {}, signal, routeId }),
  });

  const saveContract = useMutationFeedback({
    mutate: (body: McpContractBody) =>
      apiClient.request(endpoints.domains.mcp.gateway.saveContract, { body, routeId }),
    invalidates: [["mcp", "gateway"]],
    successMessage: "도구 계약을 저장했습니다.",
    errorMessage: "도구 계약을 저장하지 못했습니다.",
  });
  const removeContract = useMutationFeedback({
    mutate: (id: string) =>
      apiClient.request(endpoints.domains.mcp.gateway.deleteContract, { query: { id }, routeId }),
    invalidates: [["mcp", "gateway"]],
    successMessage: "도구 계약을 삭제했습니다.",
    errorMessage: "도구 계약을 삭제하지 못했습니다.",
  });
  const validate = useMutationFeedback({
    mutate: () => apiClient.request(endpoints.domains.mcp.gateway.validateContracts, { body: {}, routeId }),
    successMessage: (result) =>
      result.drift_count + result.missing_count === 0
        ? "드리프트가 없습니다."
        : `드리프트 ${result.drift_count}건, 누락 ${result.missing_count}건을 찾았습니다.`,
    errorMessage: "드리프트 검증을 실행하지 못했습니다.",
  });

  const connectionConfig = useMemo(() => {
    const endpointPath = info.data?.endpoint || "/mcp/gateway";
    const origin = typeof window === "undefined" ? "" : window.location.origin;
    return {
      mcpServers: {
        "vibe-gateway": {
          url: `${origin}${endpointPath}`,
          headers: { Authorization: "Bearer <발급받은 Proxy API Key>" },
        },
      },
    };
  }, [info.data?.endpoint]);

  const registryColumn = createDataTableColumnHelper<McpContract>();
  const registryColumns = [
    registryColumn.accessor((row) => row.name, {
      id: "name",
      header: "도구",
      cell: (info2) => <span className="mono">{info2.getValue<string>()}</span>,
    }),
    registryColumn.accessor((row) => row.namespace, { id: "namespace", header: "네임스페이스" }),
    registryColumn.accessor((row) => row.risk_level, {
      id: "risk",
      header: "위험도",
      cell: (info2) => <Badge tone={riskTone(info2.getValue<string>())}>{info2.getValue<string>()}</Badge>,
    }),
    registryColumn.accessor((row) => row.owner || "—", { id: "owner", header: "담당" }),
    registryColumn.accessor((row) => (row.enabled ? "사용" : "중지"), { id: "enabled", header: "상태" }),
    registryColumn.display({
      id: "actions",
      header: "작업",
      cell: (info2) => (
        <div className="mcp-row-actions">
          <Button
            size="small"
            disabled={!canWrite}
            title={canWrite ? undefined : "mcp:admin 권한이 필요합니다."}
            onClick={() => {
              const contract = info2.row.original;
              form.reset({
                id: contract.id,
                namespace: contract.namespace,
                name: contract.name,
                title: contract.title,
                description: contract.description,
                risk_level:
                  contract.risk_level === "high" || contract.risk_level === "medium"
                    ? contract.risk_level
                    : "low",
                timeout_ms: contract.timeout_ms ? String(contract.timeout_ms) : "",
                allowed_roles: contract.allowed_roles,
                cost_policy: contract.cost_policy,
                owner: contract.owner,
                input_schema: contract.input_schema,
                enabled: contract.enabled,
              });
              setFormOpen(true);
            }}
          >
            수정
          </Button>
          <Button
            size="small"
            variant="danger"
            disabled={!canWrite}
            onClick={() => setDeleteTarget(info2.row.original)}
          >
            삭제
          </Button>
        </div>
      ),
    }),
  ] as ReadonlyArray<DataTableColumn<McpContract>>;

  return (
    <div className="page-stack">
      <PageHeader
        title="Gateway MCP"
        description="게이트웨이가 스스로 제공하는 MCP 서버의 연결 정보와 도구 계약을 관리합니다."
        legacyHref="/admin#/gateway-mcp"
        actions={
          <Button
            variant="primary"
            onClick={() => void queryClient.invalidateQueries({ queryKey: ["mcp", "gateway"] })}
          >
            <RefreshCw aria-hidden="true" /> 새로고침
          </Button>
        }
      />

      {canWrite ? null : (
        <InlineNotice tone="info" title="읽기 전용으로 열려 있습니다.">
          도구 계약 등록·삭제와 드리프트 검증에는 <code>{writeScope}</code> 권한이 필요합니다.
        </InlineNotice>
      )}

      {info.isError ? (
        <QueryNotice
          error={info.error}
          hasData={Boolean(info.data)}
          label="Gateway MCP 정보"
          onRetry={() => void info.refetch()}
        />
      ) : null}

      <SectionCard
        title="연결 설정"
        description="외부 AI 에이전트가 Proxy API Key로 이 엔드포인트에 연결하면 아래 도구를 사용할 수 있습니다."
      >
        <KeyValueList
          items={[
            { label: "엔드포인트", value: info.data?.endpoint || "—", mono: true },
            { label: "프로토콜 버전", value: info.data?.protocol_version || "—", mono: true },
            { label: "도구", value: formatNumber(info.data?.tools.length ?? 0) },
            { label: "리소스", value: formatNumber(info.data?.resources.length ?? 0) },
            { label: "프롬프트", value: formatNumber(info.data?.prompts.length ?? 0) },
          ]}
        />
        <JsonBlock label="MCP 클라이언트 설정" value={connectionConfig} maxHeight={220} />
        {info.data?.note ? <p className="mcp-note">{info.data.note}</p> : null}
      </SectionCard>

      <SectionCard title="제공 도구" description="게이트웨이가 MCP로 노출하는 도구 목록입니다.">
        <DataTable
          caption="Gateway MCP 도구"
          columns={toolColumns}
          data={info.data?.tools ?? []}
          loading={info.isPending}
          getRowId={(row) => row.name}
          emptyMessage="노출 중인 도구가 없습니다."
        />
      </SectionCard>

      <SectionCard title="게시된 도구 계약" description="도구별 위험도, 비용 정책과 타임아웃 계약입니다.">
        <DataTable
          caption="Gateway MCP 게시 계약"
          columns={publishedColumns}
          data={info.data?.contracts ?? []}
          loading={info.isPending}
          getRowId={(row) => row.name}
          emptyMessage="게시된 계약이 없습니다."
        />
      </SectionCard>

      <SectionCard
        title="도구 계약 레지스트리"
        description="계약을 등록해 두면 실제 노출 도구와의 드리프트를 감지할 수 있습니다."
        actions={
          <Toolbar
            label="계약 작업"
            end={
              <>
                <Button
                  disabled={!canWrite || validate.isPending}
                  title={canWrite ? undefined : "mcp:admin 권한이 필요합니다."}
                  onClick={() => validate.mutate()}
                >
                  {validate.isPending ? "검증 중" : "드리프트 검증"}
                </Button>
                <Button
                  ref={createButtonRef}
                  variant="primary"
                  disabled={!canWrite}
                  title={canWrite ? undefined : "mcp:admin 권한이 필요합니다."}
                  onClick={() => {
                    form.reset(emptyContract);
                    setFormOpen(true);
                  }}
                >
                  <Plus aria-hidden="true" /> 계약 등록
                </Button>
              </>
            }
          >
            <span className="mcp-note">등록 {formatNumber(contracts.data?.contracts.length ?? 0)}건</span>
          </Toolbar>
        }
      >
        {contracts.isError ? (
          <QueryNotice
            error={contracts.error}
            hasData={Boolean(contracts.data)}
            label="도구 계약"
            onRetry={() => void contracts.refetch()}
          />
        ) : null}
        {!contracts.isPending && (contracts.data?.contracts.length ?? 0) === 0 ? (
          <EmptyState
            title="등록된 도구 계약이 없습니다."
            description="계약을 등록하면 게이트웨이가 노출하는 도구의 입력 스키마 변화를 자동으로 비교합니다."
          />
        ) : (
          <DataTable
            caption="MCP 도구 계약 레지스트리"
            columns={registryColumns}
            data={contracts.data?.contracts ?? []}
            loading={contracts.isPending}
            getRowId={(row) => row.id}
          />
        )}
      </SectionCard>

      {validate.data ? (
        <SectionCard
          title="드리프트 검증 결과"
          description={`검사 ${formatNumber(validate.data.checked)}건 · 드리프트 ${formatNumber(validate.data.drift_count)}건 · 누락 ${formatNumber(validate.data.missing_count)}건`}
        >
          <DataTable
            caption="도구 계약 드리프트 검증 결과"
            columns={validationColumns}
            data={validate.data.results}
            getRowId={(row, index) => `${row.contract_id}:${index}`}
            emptyMessage="검증 대상 계약이 없습니다."
          />
          {validate.data.note ? <p className="mcp-note">{validate.data.note}</p> : null}
        </SectionCard>
      ) : null}

      <FormDialog
        form={form}
        open={formOpen}
        onOpenChange={setFormOpen}
        returnFocusRef={createButtonRef}
        title="도구 계약"
        description="도구 이름과 위험도, 입력 스키마 계약을 저장합니다."
        onSubmit={async (values: ContractFormValues) => {
          await saveContract.mutateAsync({
            ...(values.id ? { id: values.id } : {}),
            namespace: values.namespace || "gateway",
            name: values.name,
            title: values.title.trim(),
            description: values.description.trim(),
            risk_level: values.risk_level,
            timeout_ms: values.timeout_ms === "" ? 0 : Number(values.timeout_ms),
            allowed_roles: values.allowed_roles.trim(),
            cost_policy: values.cost_policy.trim(),
            owner: values.owner.trim(),
            input_schema: values.input_schema.trim(),
            enabled: values.enabled,
          });
        }}
      >
        <FormField label="도구 이름" required error={form.formState.errors.name?.message}>
          {(control) => <Input {...control} {...form.register("name")} placeholder="gateway_chat" />}
        </FormField>
        <FormField label="네임스페이스" error={form.formState.errors.namespace?.message}>
          {(control) => <Input {...control} {...form.register("namespace")} />}
        </FormField>
        <FormField label="표시 제목" error={form.formState.errors.title?.message}>
          {(control) => <Input {...control} {...form.register("title")} />}
        </FormField>
        <FormField label="위험도" required error={form.formState.errors.risk_level?.message}>
          {(control) => <Select {...control} {...form.register("risk_level")} options={riskOptions} />}
        </FormField>
        <FormField label="담당" error={form.formState.errors.owner?.message}>
          {(control) => <Input {...control} {...form.register("owner")} />}
        </FormField>
        <FormField label="허용 역할 (쉼표 구분)" error={form.formState.errors.allowed_roles?.message}>
          {(control) => <Input {...control} {...form.register("allowed_roles")} />}
        </FormField>
        <FormField label="비용 정책" error={form.formState.errors.cost_policy?.message}>
          {(control) => <Input {...control} {...form.register("cost_policy")} />}
        </FormField>
        <FormField label="타임아웃(ms)" error={form.formState.errors.timeout_ms?.message}>
          {(control) => <Input {...control} {...form.register("timeout_ms")} inputMode="numeric" />}
        </FormField>
        <FormField label="설명" error={form.formState.errors.description?.message}>
          {(control) => <Textarea {...control} {...form.register("description")} rows={2} />}
        </FormField>
        <FormField label="입력 스키마 (JSON)" error={form.formState.errors.input_schema?.message}>
          {(control) => (
            <Textarea {...control} {...form.register("input_schema")} rows={4} className="mono" />
          )}
        </FormField>
        <Checkbox label="사용 (활성화)" {...form.register("enabled")} />
      </FormDialog>

      <ConfirmDialog
        open={deleteTarget !== undefined}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(undefined);
        }}
        returnFocusRef={tableRef}
        tone="danger"
        title="도구 계약을 삭제할까요?"
        description={`${deleteTarget?.name ?? ""} 계약이 삭제되어 드리프트 검증 대상에서 제외됩니다.`}
        confirmLabel="삭제"
        onConfirm={async () => {
          if (!deleteTarget) return;
          await removeContract.mutateAsync(deleteTarget.id);
          setDeleteTarget(undefined);
        }}
      />
    </div>
  );
}
