import { ShieldCheck } from "lucide-react";
import { useRef, useState } from "react";

import { useAuth } from "@/app/auth/AuthProvider";
import {
  sandboxCheckRows,
  sandboxFormDefaults,
  sandboxFormSchema,
  sandboxKindLabels,
  sandboxRequestBody,
  type SandboxFormValues,
} from "@/features/security/sandbox/sandbox-preview";
import { apiClient } from "@/shared/api/client";
import { sandboxKinds, type SandboxPreview } from "@/shared/api/domains/security";
import { endpoints } from "@/shared/api/endpoints";
import { FormField } from "@/shared/components/form/FormField";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { PageHeader } from "@/shared/components/page/PageHeader";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Input } from "@/shared/components/ui/Input";
import { Select } from "@/shared/components/ui/Select";
import { Textarea } from "@/shared/components/ui/Textarea";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";

export function SandboxPage(): React.JSX.Element {
  const auth = useAuth();
  const canRun = auth.user?.scopes.includes("admin:write") ?? false;
  const form = useZodForm<SandboxFormValues, SandboxFormValues>(sandboxFormSchema, sandboxFormDefaults);
  const [pending, setPending] = useState<SandboxFormValues | undefined>();
  const [preview, setPreview] = useState<SandboxPreview | undefined>();
  const submitRef = useRef<HTMLButtonElement | null>(null);
  const errors = form.formState.errors;

  const run = useMutationFeedback<SandboxFormValues, SandboxPreview>({
    mutate: (values) =>
      apiClient.request(endpoints.domains.security.sandboxPreview, {
        body: sandboxRequestBody(values),
        routeId: "security.sandbox",
      }),
    successMessage: (result) => (result.would_block ? "차단 예상으로 판정되었습니다." : "통과 예상입니다."),
    errorMessage: "샌드박스 검증을 실행하지 못했습니다.",
    onSuccess: (result) => setPreview(result),
  });

  const submit = form.handleSubmit((values) => {
    setPending(values);
  });

  const checkRows = preview ? sandboxCheckRows(preview) : [];

  return (
    <div className="page-stack">
      <PageHeader
        title="민감 샌드박스"
        status="preview"
        description="고위험 요청을 실제로 실행하지 않고 안전 게이트 통과 여부만 미리 확인합니다."
        legacyHref="/admin#/sandbox"
      />

      <InlineNotice tone="info" title="격리 프리뷰">
        입력한 프롬프트와 SQL은 정책·인젝션·비밀정보·SQL 검증·MCP 위험 게이트 평가에만 사용되며 저장되지
        않습니다. 업스트림 호출, 도구 실행, Text2SQL 실행은 일어나지 않습니다.
      </InlineNotice>

      {canRun ? null : (
        <InlineNotice tone="warning" title="검증을 실행할 권한이 없습니다.">
          샌드박스 검증에는 <code>admin:write</code> 권한이 필요합니다. 입력 양식은 확인할 수 있습니다.
        </InlineNotice>
      )}

      <SectionCard title="검증 대상" description="비워 둔 항목은 해당 게이트를 건너뜁니다.">
        <form className="form-grid" noValidate onSubmit={(event) => void submit(event)}>
          <div className="form-grid" data-columns="2">
            <FormField label="종류" required error={errors.kind?.message}>
              {(control) => (
                <Select {...control} {...form.register("kind")}>
                  {sandboxKinds.map((value) => (
                    <option key={value} value={value}>
                      {sandboxKindLabels[value] ?? value}
                    </option>
                  ))}
                </Select>
              )}
            </FormField>
            <FormField label="모델" error={errors.model?.message}>
              {(control) => <Input {...control} {...form.register("model")} placeholder="gpt-4.1" />}
            </FormField>
            <FormField label="공급자" error={errors.provider?.message}>
              {(control) => <Input {...control} {...form.register("provider")} placeholder="선택 입력" />}
            </FormField>
            <FormField label="팀" error={errors.team?.message}>
              {(control) => <Input {...control} {...form.register("team")} placeholder="team id (선택)" />}
            </FormField>
            <FormField label="MCP 서버" error={errors.server?.message}>
              {(control) => <Input {...control} {...form.register("server")} placeholder="server (선택)" />}
            </FormField>
            <FormField label="MCP 도구" error={errors.tool?.message}>
              {(control) => <Input {...control} {...form.register("tool")} placeholder="tool (선택)" />}
            </FormField>
          </div>
          <FormField
            label="프롬프트/질문 (선택)"
            description="원문은 저장되지 않으며 검증 결과만 표시됩니다."
            error={errors.content?.message}
          >
            {(control) => (
              <Textarea
                {...control}
                {...form.register("content")}
                rows={3}
                placeholder="검증할 프롬프트 텍스트"
              />
            )}
          </FormField>
          <FormField label="SQL (Text2SQL, 선택)" error={errors.sql?.message}>
            {(control) => (
              <Textarea {...control} {...form.register("sql")} rows={2} placeholder="SELECT ..." />
            )}
          </FormField>
          <div className="table-actions">
            <Button ref={submitRef} type="submit" variant="primary" disabled={!canRun || run.isPending}>
              {run.isPending ? "검증 중" : "샌드박스 검증"}
            </Button>
          </div>
        </form>
      </SectionCard>

      {preview ? (
        <SectionCard
          title="검증 결과"
          description={preview.note}
          actions={
            <Badge tone={preview.would_block ? "danger" : "success"}>
              {preview.would_block ? "차단 예상" : "통과 예상"}
            </Badge>
          }
        >
          {preview.reasons.length > 0 ? (
            <InlineNotice tone="warning" title="차단 사유">
              <ul>
                {preview.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </InlineNotice>
          ) : null}
          {checkRows.length > 0 ? (
            <KeyValueList items={checkRows.map((row) => ({ label: row.label, value: row.value }))} />
          ) : (
            <p role="status">평가된 게이트가 없습니다. 프롬프트, SQL 또는 MCP 도구를 입력해 보세요.</p>
          )}
        </SectionCard>
      ) : (
        <SectionCard title="검증 결과" description="아직 실행한 검증이 없습니다.">
          <p role="status">
            <ShieldCheck aria-hidden="true" /> 검증을 실행하면 게이트별 판정이 여기에 표시됩니다.
          </p>
        </SectionCard>
      )}

      <ConfirmDialog
        open={pending !== undefined}
        onOpenChange={(open) => {
          if (!open) setPending(undefined);
        }}
        returnFocusRef={submitRef}
        title="샌드박스 검증을 실행할까요?"
        description="입력한 내용이 안전 게이트 평가를 위해 게이트웨이로 전송됩니다. 저장되지 않으며 실제 실행도 일어나지 않습니다."
        confirmLabel="검증 실행"
        onConfirm={async () => {
          if (!pending) return;
          await run.mutateAsync(pending);
        }}
      />
    </div>
  );
}
