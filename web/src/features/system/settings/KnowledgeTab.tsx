import { useQuery } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { z } from "zod";

import { QueryNotice, UpdatedAt, WriteGate } from "@/features/system/settings/SettingsParts";
import { routeId } from "@/features/system/settings/use-system-settings";
import { apiClient } from "@/shared/api/client";
import type { KnowledgeSnippet } from "@/shared/api/domains/system.schemas";
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
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Textarea } from "@/shared/components/ui/Textarea";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { formatNumber, formatRelative } from "@/shared/utils/format";

const system = endpoints.domains.system;
const knowledgeKey = ["system", "knowledge"] as const;

const createSchema = z.object({
  name: z.string().trim().min(1, "이름을 입력하세요."),
  id: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]*$/, "ID는 영문, 숫자, - 와 _ 만 쓸 수 있습니다.")
    .optional(),
  content: z.string().trim().min(1, "본문을 입력하세요."),
});
type CreateValues = z.infer<typeof createSchema>;

/**
 * The knowledge cache: rules and system prompts registered once here and pulled in by a
 * client as `{{kb:ID}}` or the `X-Vibe-Knowledge` header, so the same rule is edited in
 * one place instead of being repeated in every caller's payload.
 */
export function KnowledgeTab({ hasAdminWrite }: { hasAdminWrite: boolean }): React.JSX.Element {
  const [createOpen, setCreateOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<KnowledgeSnippet | undefined>();
  const createTriggerRef = useRef<HTMLButtonElement>(null);
  const deleteTriggerRef = useRef<HTMLElement | null>(null);
  const form = useZodForm<CreateValues, CreateValues>(createSchema, { name: "", id: "", content: "" });
  const { reset } = form;

  const snippets = useQuery({
    queryKey: knowledgeKey,
    queryFn: ({ signal }) => apiClient.request(system.knowledge.list, { routeId, signal }),
  });

  const create = useMutationFeedback({
    mutate: async (values: CreateValues) =>
      apiClient.request(system.knowledge.create, {
        body: { name: values.name, content: values.content, ...(values.id ? { id: values.id } : {}) },
        routeId,
      }),
    invalidates: [knowledgeKey],
    successMessage: "지식 항목을 등록했습니다.",
    errorMessage: "지식 항목을 등록하지 못했습니다.",
    onSuccess: () => {
      setCreateOpen(false);
      reset({ name: "", id: "", content: "" });
    },
  });

  const toggle = useMutationFeedback({
    mutate: async (snippet: KnowledgeSnippet) =>
      apiClient.request(withPathParams(system.knowledge.update, { id: snippet.id }), {
        body: { enabled: !snippet.enabled },
        routeId,
      }),
    invalidates: [knowledgeKey],
    successMessage: (_result, snippet) =>
      snippet.enabled ? "지식 항목 사용을 중지했습니다." : "지식 항목을 다시 사용합니다.",
    errorMessage: "지식 항목 상태를 바꾸지 못했습니다.",
  });

  const remove = useMutationFeedback({
    mutate: async (snippet: KnowledgeSnippet) =>
      apiClient.request(withPathParams(system.knowledge.remove, { id: snippet.id }), { routeId }),
    invalidates: [knowledgeKey],
    successMessage: "지식 항목을 삭제했습니다.",
    errorMessage: "지식 항목을 삭제하지 못했습니다.",
    onSuccess: () => setPendingDelete(undefined),
  });

  const rows = snippets.data?.snippets ?? [];
  const writeDeniedReason = hasAdminWrite
    ? undefined
    : "변경 권한(admin:write)이 없어 읽기만 할 수 있습니다.";

  return (
    <div className="settings-tab-stack">
      {snippets.isError ? (
        <QueryNotice
          error={snippets.error}
          hasPreviousData={snippets.data !== undefined}
          label="지식 캐시"
          onRetry={() => void snippets.refetch()}
        />
      ) : null}

      <SectionCard
        title="지식 캐시"
        description="반복되는 규칙과 시스템 프롬프트를 한 번 등록하면, 클라이언트는 본문 대신 {{kb:ID}} 참조나 X-Vibe-Knowledge 헤더만 보내면 됩니다. 게이트웨이가 업스트림으로 보낼 때 전체 본문으로 펼칩니다."
        actions={
          <WriteGate reason={writeDeniedReason}>
            <Button
              ref={createTriggerRef}
              size="small"
              variant="primary"
              disabled={!hasAdminWrite}
              onClick={() => setCreateOpen(true)}
            >
              <Plus aria-hidden="true" /> 항목 등록
            </Button>
          </WriteGate>
        }
      >
        {snippets.isPending ? (
          <p className="metric-note">불러오는 중…</p>
        ) : rows.length === 0 ? (
          <EmptyState
            title="등록된 지식 항목이 없습니다."
            description="자주 쓰는 규칙을 등록하면 호출마다 본문을 반복해 보내지 않아도 됩니다."
          />
        ) : (
          <table className="data-table">
            <caption className="sr-only">등록된 지식 항목</caption>
            <thead>
              <tr>
                <th scope="col">이름 / ID</th>
                <th scope="col">토큰</th>
                <th scope="col">사용 횟수</th>
                <th scope="col">최근 사용</th>
                <th scope="col">참조</th>
                <th scope="col">상태</th>
                <th scope="col">동작</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((snippet) => (
                <tr key={snippet.id}>
                  <td>
                    <strong>{snippet.name}</strong>
                    <div className="metric-note">{snippet.id}</div>
                  </td>
                  <td>{formatNumber(snippet.token_estimate ?? 0)}</td>
                  <td>{formatNumber(snippet.use_count ?? 0)}</td>
                  <td className="metric-note">
                    {snippet.last_used_at ? formatRelative(snippet.last_used_at) : "미사용"}
                  </td>
                  <td>
                    <code>{`{{kb:${snippet.id}}}`}</code>
                  </td>
                  <td>
                    <Badge tone={snippet.enabled ? "success" : "muted"}>
                      {snippet.enabled ? "사용" : "중지"}
                    </Badge>
                  </td>
                  <td>
                    <Button
                      size="small"
                      disabled={!hasAdminWrite || toggle.isPending}
                      onClick={() => toggle.mutate(snippet)}
                    >
                      {snippet.enabled ? "중지" : "사용"}
                    </Button>{" "}
                    <Button
                      size="small"
                      variant="danger"
                      disabled={!hasAdminWrite}
                      onClick={(event) => {
                        deleteTriggerRef.current = event.currentTarget;
                        setPendingDelete(snippet);
                      }}
                    >
                      <Trash2 aria-hidden="true" /> 삭제
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <UpdatedAt at={snippets.dataUpdatedAt} />
      </SectionCard>

      <FormDialog
        open={createOpen}
        onOpenChange={(next) => {
          setCreateOpen(next);
          if (!next) reset({ name: "", id: "", content: "" });
        }}
        form={form}
        returnFocusRef={createTriggerRef}
        title="지식 항목 등록"
        description="등록한 본문은 업스트림 요청에서 참조 자리에 그대로 펼쳐집니다."
        submitLabel="등록"
        onSubmit={async (values) => {
          await create.mutateAsync(values);
        }}
      >
        <FormField label="이름" error={form.formState.errors.name?.message} required>
          {(control) => <Input {...control} {...form.register("name")} placeholder="예: 사내 코딩 규칙" />}
        </FormField>
        <FormField
          label="ID"
          description="비우면 이름에서 자동으로 만듭니다. 클라이언트가 {{kb:ID}}로 참조합니다."
          error={form.formState.errors.id?.message}
        >
          {(control) => <Input {...control} {...form.register("id")} placeholder="coding-rules" />}
        </FormField>
        <FormField label="본문" error={form.formState.errors.content?.message} required>
          {(control) => <Textarea {...control} {...form.register("content")} rows={6} />}
        </FormField>
      </FormDialog>

      <ConfirmDialog
        open={pendingDelete !== undefined}
        onOpenChange={(next) => {
          if (!next) setPendingDelete(undefined);
        }}
        returnFocusRef={deleteTriggerRef}
        title="지식 항목을 삭제할까요?"
        description={`이 ID를 참조하는 호출은 더 이상 펼쳐지지 않습니다: ${pendingDelete?.id ?? ""}`}
        confirmLabel="삭제"
        tone="danger"
        onConfirm={() => {
          if (pendingDelete) remove.mutate(pendingDelete);
        }}
      />
    </div>
  );
}
