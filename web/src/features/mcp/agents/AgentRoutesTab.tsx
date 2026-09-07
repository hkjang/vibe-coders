import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { z } from "zod";

import { QueryNotice } from "@/features/mcp/mcp-ui";
import { apiClient } from "@/shared/api/client";
import type { AgentRouteBody } from "@/shared/api/domains/mcp";
import type { AgentRouteRow } from "@/shared/api/domains/mcp.schemas";
import { withPathParams } from "@/shared/api/endpoint-factory";
import { endpoints } from "@/shared/api/endpoints";
import { providerDisplayLabel } from "@/shared/api/provider-ref";
import { FormDialog } from "@/shared/components/form/FormDialog";
import { FormField } from "@/shared/components/form/FormField";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { Checkbox } from "@/shared/components/ui/Checkbox";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { Dialog } from "@/shared/components/ui/Dialog";
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
import { formatKRW, formatNumber } from "@/shared/utils/format";

const routeId = "agents.registry";

const routeFormSchema = z.object({
  id: z.string(),
  virtual_model: z
    .string()
    .trim()
    .min(1, "가상 모델명을 입력하세요.")
    .refine((value) => !/\s/u.test(value), "공백 없이 입력하세요."),
  name: z.string(),
  provider: z.string(),
  backing_model: z.string(),
  max_steps: z
    .string()
    .trim()
    .refine((value) => value === "" || /^([0-9]|1[0-6])$/u.test(value), "0에서 16 사이로 입력하세요."),
  max_cost_krw: z
    .string()
    .trim()
    .refine((value) => value === "" || /^\d+(\.\d+)?$/u.test(value), "0 이상의 숫자를 입력하세요."),
  system_prompt: z.string(),
  enabled: z.boolean(),
});
type RouteFormValues = z.infer<typeof routeFormSchema>;

const emptyRoute: RouteFormValues = {
  id: "",
  virtual_model: "",
  name: "",
  provider: "",
  backing_model: "",
  max_steps: "6",
  max_cost_krw: "",
  system_prompt: "",
  enabled: true,
};

function valuesFrom(route: AgentRouteRow): RouteFormValues {
  return {
    id: route.id,
    virtual_model: route.virtual_model,
    name: route.name,
    provider: route.provider,
    backing_model: route.backing_model,
    max_steps: String(route.max_steps),
    max_cost_krw: route.max_cost_krw ? String(route.max_cost_krw) : "",
    system_prompt: route.system_prompt,
    enabled: route.enabled,
  };
}

export function AgentRoutesTab({ canWrite }: { canWrite: boolean }): React.JSX.Element {
  const [formOpen, setFormOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AgentRouteRow | undefined>();
  const [testTarget, setTestTarget] = useState<AgentRouteRow | undefined>();
  const [exampleTarget, setExampleTarget] = useState<AgentRouteRow | undefined>();
  const [prompt, setPrompt] = useState("");
  const [selectedUpstreams, setSelectedUpstreams] = useState<readonly string[]>([]);
  const [selectedTools, setSelectedTools] = useState<readonly string[]>([]);
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const tableRef = useRef<HTMLElement>(null);

  const form = useZodForm(routeFormSchema, emptyRoute);

  const routes = useQuery({
    queryKey: ["agents", "routes"],
    queryFn: ({ signal }) => apiClient.request(endpoints.domains.mcp.agents.routes, { signal, routeId }),
  });
  const providers = useQuery({
    queryKey: ["admin", "providers"],
    queryFn: ({ signal }) => apiClient.request(endpoints.admin.providers.list, { signal, routeId }),
  });
  const upstreams = useQuery({
    queryKey: ["mcp", "upstreams"],
    queryFn: ({ signal }) => apiClient.request(endpoints.domains.mcp.upstreams, { signal, routeId }),
  });
  const toolCatalog = useQuery({
    queryKey: ["agents", "tool-catalog", selectedUpstreams],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.mcp.agents.toolCatalog, {
        query: selectedUpstreams.length > 0 ? { upstream: [...selectedUpstreams] } : {},
        signal,
        routeId,
      }),
    enabled: formOpen,
  });

  const saveRoute = useMutationFeedback({
    mutate: (body: AgentRouteBody) =>
      apiClient.request(endpoints.domains.mcp.agents.saveRoute, { body, routeId }),
    invalidates: [["agents"]],
    successMessage: "에이전트 라우트를 저장했습니다.",
    errorMessage: "에이전트 라우트를 저장하지 못했습니다.",
  });
  const removeRoute = useMutationFeedback({
    mutate: (id: string) =>
      apiClient.request(withPathParams(endpoints.domains.mcp.agents.deleteRoute, { id }), { routeId }),
    invalidates: [["agents"]],
    successMessage: "에이전트 라우트를 삭제했습니다.",
    errorMessage: "에이전트 라우트를 삭제하지 못했습니다.",
  });
  const testRoute = useMutationFeedback({
    mutate: (variables: { id: string; prompt: string }) =>
      apiClient.request(withPathParams(endpoints.domains.mcp.agents.testRoute, { id: variables.id }), {
        body: variables.prompt ? { prompt: variables.prompt } : {},
        routeId,
      }),
    errorMessage: "라우트 테스트를 실행하지 못했습니다.",
  });

  const providerOptions = useMemo(() => {
    const options = (providers.data?.providers ?? []).map((provider) => ({
      value: provider.name,
      label: providerDisplayLabel(provider.name, provider.provider_ref),
    }));
    return [{ value: "", label: "자동 (라우팅 규칙 사용)" }, ...options];
  }, [providers.data?.providers]);

  const upstreamOptions = (upstreams.data?.upstreams ?? []).filter((upstream) => upstream.enabled);

  const openCreate = (): void => {
    form.reset(emptyRoute);
    setSelectedUpstreams([]);
    setSelectedTools([]);
    setFormOpen(true);
  };

  const openEdit = (route: AgentRouteRow): void => {
    form.reset(valuesFrom(route));
    setSelectedUpstreams(route.mcp_upstreams);
    setSelectedTools(route.allowed_tools);
    setFormOpen(true);
  };

  const bodyFrom = (route: AgentRouteRow, overrides: Partial<AgentRouteBody> = {}): AgentRouteBody => ({
    id: route.id,
    virtual_model: route.virtual_model,
    name: route.name,
    enabled: route.enabled,
    backing_model: route.backing_model,
    provider: route.provider,
    mcp_upstreams: route.mcp_upstreams,
    allowed_tools: route.allowed_tools,
    system_prompt: route.system_prompt,
    max_steps: route.max_steps,
    max_cost_krw: route.max_cost_krw,
    ...overrides,
  });

  const column = createDataTableColumnHelper<AgentRouteRow>();
  const columns = [
    column.accessor((row) => row.virtual_model, {
      id: "model",
      header: "가상 모델",
      cell: (info) => (
        <div>
          <strong className="mono">{info.getValue<string>()}</strong>
          <div>{info.row.original.name}</div>
        </div>
      ),
    }),
    column.accessor((row) => row.enabled, {
      id: "enabled",
      header: "상태",
      cell: (info) =>
        info.getValue<boolean>() ? <Badge tone="success">사용</Badge> : <Badge tone="muted">중지</Badge>,
    }),
    column.accessor((row) => row.provider || "자동", { id: "provider", header: "프로바이더" }),
    column.accessor((row) => row.backing_model || "자동 선택", { id: "backing", header: "백킹 모델" }),
    column.accessor((row) => formatNumber(row.mcp_upstreams.length), {
      id: "upstreams",
      header: "MCP 서버",
    }),
    column.accessor(
      (row) => (row.allowed_tools.length > 0 ? formatNumber(row.allowed_tools.length) : "전체"),
      {
        id: "tools",
        header: "허용 도구",
      },
    ),
    column.accessor((row) => formatNumber(row.max_steps), { id: "steps", header: "최대 스텝" }),
    column.accessor((row) => (row.max_cost_krw > 0 ? formatKRW(row.max_cost_krw) : "무제한"), {
      id: "cost",
      header: "비용 한도",
    }),
    column.display({
      id: "actions",
      header: "작업",
      cell: (info) => {
        const route = info.row.original;
        return (
          <div className="mcp-row-actions">
            <Button size="small" onClick={() => setExampleTarget(route)}>
              호출 예시
            </Button>
            <Button
              size="small"
              disabled={!canWrite}
              title={canWrite ? undefined : "admin:write 권한이 필요합니다."}
              onClick={() => {
                setPrompt("");
                testRoute.reset();
                setTestTarget(route);
              }}
            >
              테스트
            </Button>
            <Button size="small" disabled={!canWrite} onClick={() => openEdit(route)}>
              수정
            </Button>
            <Button
              size="small"
              disabled={!canWrite || saveRoute.isPending}
              onClick={() => saveRoute.mutate(bodyFrom(route, { enabled: !route.enabled }))}
            >
              {route.enabled ? "중지" : "사용"}
            </Button>
            <Button size="small" variant="danger" disabled={!canWrite} onClick={() => setDeleteTarget(route)}>
              삭제
            </Button>
          </div>
        );
      },
    }),
  ] as ReadonlyArray<DataTableColumn<AgentRouteRow>>;

  const toggleValue = (list: readonly string[], value: string, checked: boolean): readonly string[] =>
    checked ? [...list, value] : list.filter((entry) => entry !== value);

  return (
    <div className="mcp-section-stack">
      {routes.isError ? (
        <QueryNotice
          error={routes.error}
          hasData={Boolean(routes.data)}
          label="에이전트 라우트"
          onRetry={() => void routes.refetch()}
        />
      ) : null}

      <SectionCard
        title="에이전트 라우트"
        description="가상 모델명을 호출하면 지정한 프로바이더와 MCP 서버로 에이전틱하게 응답합니다."
        actions={
          <Toolbar
            label="라우트 작업"
            end={
              <Button
                ref={createButtonRef}
                variant="primary"
                disabled={!canWrite}
                title={canWrite ? undefined : "admin:write 권한이 필요합니다."}
                onClick={openCreate}
              >
                <Plus aria-hidden="true" /> 라우트 생성
              </Button>
            }
          >
            <span className="mcp-note">등록 {formatNumber(routes.data?.agent_routes.length ?? 0)}개</span>
          </Toolbar>
        }
      >
        {!routes.isPending && (routes.data?.agent_routes.length ?? 0) === 0 ? (
          <EmptyState
            title="등록된 에이전트 라우트가 없습니다."
            description="가상 모델을 만들면 클라이언트는 model 값만 바꿔 MCP 도구를 쓰는 에이전트를 호출할 수 있습니다."
            actions={
              <Button variant="primary" disabled={!canWrite} onClick={openCreate}>
                라우트 생성
              </Button>
            }
          />
        ) : (
          <DataTable
            caption="에이전트 라우트 목록"
            columns={columns}
            data={routes.data?.agent_routes ?? []}
            loading={routes.isPending}
            getRowId={(row) => row.id}
          />
        )}
      </SectionCard>

      <FormDialog
        form={form}
        open={formOpen}
        onOpenChange={setFormOpen}
        returnFocusRef={createButtonRef}
        title="에이전트 라우트"
        description="가상 모델명과 백킹 모델, 노출할 MCP 도구를 지정합니다."
        onSubmit={async (values: RouteFormValues) => {
          await saveRoute.mutateAsync({
            ...(values.id ? { id: values.id } : {}),
            virtual_model: values.virtual_model,
            name: values.name.trim() || values.virtual_model,
            enabled: values.enabled,
            backing_model: values.backing_model.trim(),
            provider: values.provider,
            mcp_upstreams: [...selectedUpstreams],
            allowed_tools: [...selectedTools],
            system_prompt: values.system_prompt,
            max_steps: values.max_steps === "" ? 0 : Number(values.max_steps),
            max_cost_krw: values.max_cost_krw === "" ? 0 : Number(values.max_cost_krw),
          });
        }}
      >
        <FormField
          label="가상 모델명"
          required
          error={form.formState.errors.virtual_model?.message}
          description="클라이언트가 model 값으로 지정할 이름입니다. 예: vibe/agent-research"
        >
          {(control) => <Input {...control} {...form.register("virtual_model")} />}
        </FormField>
        <FormField label="표시 이름" error={form.formState.errors.name?.message}>
          {(control) => <Input {...control} {...form.register("name")} />}
        </FormField>
        <FormField label="프로바이더" error={form.formState.errors.provider?.message}>
          {(control) => <Select {...control} {...form.register("provider")} options={providerOptions} />}
        </FormField>
        <FormField
          label="백킹 모델"
          error={form.formState.errors.backing_model?.message}
          description="비우면 라우팅 규칙이 모델을 선택합니다."
        >
          {(control) => <Input {...control} {...form.register("backing_model")} />}
        </FormField>
        <FormField label="최대 스텝 (0-16)" error={form.formState.errors.max_steps?.message}>
          {(control) => <Input {...control} {...form.register("max_steps")} inputMode="numeric" />}
        </FormField>
        <FormField
          label="호출당 비용 한도 (KRW)"
          error={form.formState.errors.max_cost_krw?.message}
          description="0이면 제한하지 않습니다."
        >
          {(control) => <Input {...control} {...form.register("max_cost_krw")} inputMode="decimal" />}
        </FormField>
        <Checkbox label="사용 (활성화)" {...form.register("enabled")} />

        <fieldset>
          <legend>MCP 업스트림</legend>
          <div className="mcp-checkbox-list">
            {upstreamOptions.length === 0 ? (
              <p className="mcp-note">사용 가능한 업스트림이 없습니다.</p>
            ) : (
              upstreamOptions.map((upstream) => (
                <Checkbox
                  key={upstream.id}
                  label={upstream.name || upstream.id}
                  description={upstream.id}
                  checked={selectedUpstreams.includes(upstream.id)}
                  onChange={(event) =>
                    setSelectedUpstreams((prev) => toggleValue(prev, upstream.id, event.target.checked))
                  }
                />
              ))
            )}
          </div>
        </fieldset>

        <fieldset>
          <legend>허용 도구 (비우면 전체 허용)</legend>
          <div className="mcp-checkbox-list">
            {toolCatalog.isPending ? (
              <p className="mcp-note" role="status">
                도구 목록을 불러오는 중입니다.
              </p>
            ) : (toolCatalog.data?.tools.length ?? 0) === 0 ? (
              <p className="mcp-note">노출 중인 도구가 없습니다.</p>
            ) : (
              (toolCatalog.data?.tools ?? []).map((tool) => (
                <Checkbox
                  key={tool.namespaced}
                  label={tool.namespaced}
                  description={tool.description}
                  checked={selectedTools.includes(tool.namespaced)}
                  onChange={(event) =>
                    setSelectedTools((prev) => toggleValue(prev, tool.namespaced, event.target.checked))
                  }
                />
              ))
            )}
          </div>
          {Object.entries(toolCatalog.data?.errors ?? {}).map(([upstream, message]) => (
            <InlineNotice key={upstream} tone="warning" title={`${upstream} 도구 조회 실패`}>
              <p className="mono">{message}</p>
            </InlineNotice>
          ))}
        </fieldset>

        <FormField label="시스템 프롬프트" error={form.formState.errors.system_prompt?.message}>
          {(control) => <Textarea {...control} {...form.register("system_prompt")} rows={3} />}
        </FormField>
      </FormDialog>

      <ConfirmDialog
        open={deleteTarget !== undefined}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(undefined);
        }}
        returnFocusRef={tableRef}
        tone="danger"
        title="에이전트 라우트를 삭제할까요?"
        description={`${deleteTarget?.virtual_model ?? ""} 가상 모델 호출이 즉시 중단됩니다.`}
        confirmLabel="삭제"
        onConfirm={async () => {
          if (!deleteTarget) return;
          await removeRoute.mutateAsync(deleteTarget.id);
          setDeleteTarget(undefined);
        }}
      />

      <Dialog
        open={testTarget !== undefined}
        onOpenChange={(open) => {
          if (!open) setTestTarget(undefined);
        }}
        returnFocusRef={tableRef}
        title="라우트 테스트"
        description="서버에서 한 번 실행해 도구 호출과 응답을 확인합니다."
        footer={
          <Button
            variant="primary"
            disabled={testRoute.isPending || !testTarget}
            onClick={() => testTarget && testRoute.mutate({ id: testTarget.id, prompt: prompt.trim() })}
          >
            {testRoute.isPending ? "실행 중" : "테스트 실행"}
          </Button>
        }
      >
        <FormField label="테스트 프롬프트" description="비우면 기본 점검 프롬프트를 사용합니다.">
          {(control) => (
            <Textarea
              {...control}
              rows={3}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
            />
          )}
        </FormField>
        {testRoute.data ? (
          <>
            <KeyValueList
              items={[
                { label: "결과", value: testRoute.data.ok ? "성공" : "실패" },
                { label: "상태 코드", value: formatNumber(testRoute.data.status) },
                { label: "백킹 모델", value: testRoute.data.backing_model || "—", mono: true },
                { label: "도구 수", value: formatNumber(testRoute.data.tools) },
                { label: "스텝", value: formatNumber(testRoute.data.steps) },
                { label: "도구 호출", value: formatNumber(testRoute.data.tool_calls) },
              ]}
            />
            <JsonBlock label="응답 내용" value={testRoute.data.content} maxHeight={220} />
          </>
        ) : null}
      </Dialog>

      <Dialog
        open={exampleTarget !== undefined}
        onOpenChange={(open) => {
          if (!open) setExampleTarget(undefined);
        }}
        returnFocusRef={tableRef}
        title="호출 예시"
        description="클라이언트는 model 값만 이 가상 모델명으로 지정하면 됩니다."
      >
        <JsonBlock
          label="OpenAI 호환 요청 본문"
          value={{
            model: exampleTarget?.virtual_model ?? "",
            messages: [{ role: "user", content: "필요한 도구를 사용해 답변해 주세요." }],
            stream: false,
          }}
          maxHeight={200}
        />
        <p className="mcp-note">
          POST /v1/chat/completions 에 Authorization: Bearer &lt;Proxy API Key&gt; 헤더와 함께 보내세요.
        </p>
      </Dialog>
    </div>
  );
}
