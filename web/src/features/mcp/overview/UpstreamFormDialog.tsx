import { useState, type RefObject } from "react";
import { z } from "zod";

import { csvToList, listToCsv } from "@/features/mcp/mcp-utils";
import { apiClient } from "@/shared/api/client";
import type { McpUpstreamBody } from "@/shared/api/domains/mcp";
import {
  onboardingRejectionSchema,
  type McpUpstream,
  type OnboardingCheck,
} from "@/shared/api/domains/mcp.schemas";
import { endpoints } from "@/shared/api/endpoints";
import { isAppError } from "@/shared/api/error";
import { FormDialog } from "@/shared/components/form/FormDialog";
import { FormField } from "@/shared/components/form/FormField";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { Button } from "@/shared/components/ui/Button";
import { Checkbox } from "@/shared/components/ui/Checkbox";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { Select } from "@/shared/components/ui/Select";
import { Textarea } from "@/shared/components/ui/Textarea";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";

const routeId = "mcp.overview";

const numericText = z
  .string()
  .trim()
  .refine((value) => value === "" || /^\d+$/u.test(value), "0 이상의 정수를 입력하세요.");

const upstreamFormSchema = z.object({
  id: z
    .string()
    .trim()
    .refine((value) => value === "" || /^[a-z0-9][a-z0-9-]*$/u.test(value), {
      message: "영문 소문자, 숫자와 하이픈만 사용할 수 있습니다.",
    }),
  name: z.string().trim().min(1, "표시 이름을 입력하세요.").max(128),
  url: z
    .string()
    .trim()
    .refine((value) => /^https?:\/\/\S+$/iu.test(value), "http(s)로 시작하는 절대 URL을 입력하세요."),
  auth_token: z.string(),
  enabled: z.boolean(),
  risk_level: z.string(),
  description: z.string(),
  domains: z.string(),
  allowed_models: z.string(),
  default_tool: z.string(),
  timeout_ms: numericText,
  max_results: numericText,
  requires_approval: z.boolean(),
  fallback_allowed: z.boolean(),
});

type UpstreamFormValues = z.infer<typeof upstreamFormSchema>;

const emptyValues: UpstreamFormValues = {
  id: "",
  name: "",
  url: "",
  auth_token: "",
  enabled: true,
  risk_level: "",
  description: "",
  domains: "",
  allowed_models: "",
  default_tool: "",
  timeout_ms: "",
  max_results: "",
  requires_approval: false,
  fallback_allowed: false,
};

const riskOptions = [
  { value: "", label: "선택 안 함" },
  { value: "low", label: "low (낮음)" },
  { value: "medium", label: "medium (보통)" },
  { value: "high", label: "high (높음)" },
  { value: "critical", label: "critical (매우 높음)" },
];

function toBody(values: UpstreamFormValues): McpUpstreamBody {
  const token = values.auth_token.trim();
  return {
    ...(values.id.trim() ? { id: values.id.trim() } : {}),
    name: values.name.trim(),
    url: values.url.trim(),
    ...(token ? { auth_token: token } : {}),
    enabled: values.enabled,
    metadata: {
      description: values.description.trim(),
      domains: csvToList(values.domains),
      risk_level: values.risk_level,
      allowed_models: csvToList(values.allowed_models),
      default_tool: values.default_tool.trim(),
      timeout_ms: values.timeout_ms === "" ? 0 : Number(values.timeout_ms),
      max_results: values.max_results === "" ? 0 : Number(values.max_results),
      requires_approval: values.requires_approval,
      fallback_allowed: values.fallback_allowed,
    },
  };
}

function valuesFrom(upstream: McpUpstream | undefined): UpstreamFormValues {
  if (!upstream) return emptyValues;
  return {
    id: upstream.id,
    name: upstream.name,
    url: upstream.url,
    auth_token: "",
    enabled: upstream.enabled,
    risk_level: upstream.metadata?.risk_level ?? "",
    description: upstream.metadata?.description ?? "",
    domains: listToCsv(upstream.metadata?.domains),
    allowed_models: listToCsv(upstream.metadata?.allowed_models),
    default_tool: upstream.metadata?.default_tool ?? "",
    timeout_ms: upstream.metadata?.timeout_ms ? String(upstream.metadata.timeout_ms) : "",
    max_results: upstream.metadata?.max_results ? String(upstream.metadata.max_results) : "",
    requires_approval: upstream.metadata?.requires_approval ?? false,
    fallback_allowed: upstream.metadata?.fallback_allowed ?? false,
  };
}

interface UpstreamFormDialogProps {
  canWrite: boolean;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  returnFocusRef: RefObject<HTMLElement | null>;
  upstream?: McpUpstream;
}

/**
 * Registers or re-saves one MCP upstream. The server exposes only an upsert, so an
 * edit resends every field; the auth token is write-only and must be re-entered.
 * The caller remounts this dialog (via `key`) whenever it opens, so the form starts
 * from the current upstream without an effect.
 */
export function UpstreamFormDialog({
  canWrite,
  onOpenChange,
  open,
  returnFocusRef,
  upstream,
}: UpstreamFormDialogProps): React.JSX.Element {
  const form = useZodForm(upstreamFormSchema, valuesFrom(upstream));
  const [gate, setGate] = useState<ReadonlyArray<OnboardingCheck>>([]);
  const [checklist, setChecklist] = useState<ReadonlyArray<OnboardingCheck>>([]);

  const save = useMutationFeedback({
    mutate: (variables: { body: McpUpstreamBody; force?: "1" }) =>
      apiClient.request(endpoints.domains.mcp.saveUpstream, {
        body: variables.body,
        ...(variables.force ? { query: { force: variables.force } } : {}),
        routeId,
      }),
    invalidates: [["mcp"]],
    successMessage: "업스트림을 저장했습니다.",
    errorMessage: "업스트림을 저장하지 못했습니다.",
  });

  const check = useMutationFeedback({
    mutate: (body: McpUpstreamBody) =>
      apiClient.request(endpoints.domains.mcp.onboardingCheck, { body, routeId }),
    errorMessage: "온보딩 점검을 실행하지 못했습니다.",
    onSuccess: (result) => setChecklist(result.checks),
  });

  const submit = async (values: UpstreamFormValues): Promise<void> => {
    setGate([]);
    try {
      await save.mutateAsync({ body: toBody(values) });
    } catch (error) {
      if (isAppError(error) && error.status === 422) {
        const parsed = onboardingRejectionSchema.safeParse(error.details);
        if (parsed.success) setGate(parsed.data.failed.length > 0 ? parsed.data.failed : parsed.data.checks);
      }
      throw error;
    }
  };

  const errors = form.formState.errors;

  return (
    <FormDialog
      form={form}
      open={open}
      onOpenChange={onOpenChange}
      onSubmit={submit}
      returnFocusRef={returnFocusRef}
      title={upstream ? "업스트림 수정" : "업스트림 등록"}
      description="게이트웨이가 도구를 모아 노출할 MCP 서버 정보를 입력합니다."
      submitLabel={upstream ? "저장" : "등록"}
    >
      <FormField
        label="업스트림 ID (슬러그)"
        error={errors.id?.message}
        description="비우면 이름에서 자동 생성합니다. 도구 이름 앞에 붙는 네임스페이스입니다."
      >
        {(control) => (
          <Input {...control} {...form.register("id")} readOnly={Boolean(upstream)} placeholder="github" />
        )}
      </FormField>
      <FormField label="표시 이름" required error={errors.name?.message}>
        {(control) => <Input {...control} {...form.register("name")} placeholder="GitHub MCP" />}
      </FormField>
      <FormField label="MCP 엔드포인트 URL" required error={errors.url?.message}>
        {(control) => (
          <Input {...control} {...form.register("url")} placeholder="https://mcp.example.com/mcp" />
        )}
      </FormField>
      <FormField
        label="인증 토큰"
        error={errors.auth_token?.message}
        description={
          upstream?.has_auth
            ? "이미 토큰이 설정되어 있습니다. 비워 두고 저장하면 기존 토큰이 삭제됩니다."
            : "업스트림 호출에 사용할 Bearer 토큰입니다. 저장 후에는 다시 표시되지 않습니다."
        }
      >
        {(control) => (
          <Input {...control} {...form.register("auth_token")} type="password" autoComplete="off" />
        )}
      </FormField>
      <Checkbox label="사용 (활성화)" {...form.register("enabled")} />
      <FormField label="위험 등급" error={errors.risk_level?.message}>
        {(control) => <Select {...control} {...form.register("risk_level")} options={riskOptions} />}
      </FormField>
      <Checkbox
        label="도구 호출 전 승인 필요"
        description="high/critical 위험 업스트림은 승인 게이트가 필수입니다."
        {...form.register("requires_approval")}
      />
      <Checkbox label="폴백 허용" {...form.register("fallback_allowed")} />
      <FormField label="설명" error={errors.description?.message}>
        {(control) => <Textarea {...control} {...form.register("description")} rows={2} />}
      </FormField>
      <FormField label="도메인 (쉼표 구분)" error={errors.domains?.message}>
        {(control) => <Input {...control} {...form.register("domains")} placeholder="code, issue" />}
      </FormField>
      <FormField label="허용 모델 (쉼표 구분)" error={errors.allowed_models?.message}>
        {(control) => <Input {...control} {...form.register("allowed_models")} />}
      </FormField>
      <FormField label="기본 도구" error={errors.default_tool?.message}>
        {(control) => <Input {...control} {...form.register("default_tool")} />}
      </FormField>
      <FormField label="타임아웃(ms)" error={errors.timeout_ms?.message}>
        {(control) => <Input {...control} {...form.register("timeout_ms")} inputMode="numeric" />}
      </FormField>
      <FormField label="최대 결과 수" error={errors.max_results?.message}>
        {(control) => <Input {...control} {...form.register("max_results")} inputMode="numeric" />}
      </FormField>

      <div className="mcp-row-actions">
        <Button
          disabled={!canWrite || check.isPending}
          onClick={() => check.mutate(toBody(form.getValues()))}
        >
          {check.isPending ? "점검 중" : "온보딩 점검"}
        </Button>
      </div>

      {checklist.length > 0 ? (
        <InlineNotice
          tone={checklist.every((item) => item.ok || item.severity !== "required") ? "success" : "warning"}
          title="온보딩 점검 결과"
        >
          <ul>
            {checklist.map((item) => (
              <li key={item.key}>
                {item.ok ? "✅" : item.severity === "required" ? "⛔" : "⚠️"} {item.key} — {item.detail}
              </li>
            ))}
          </ul>
        </InlineNotice>
      ) : null}

      {gate.length > 0 ? (
        <InlineNotice
          tone="danger"
          title="활성화 전 필수 항목이 충족되지 않았습니다."
          actions={
            <Button
              variant="danger"
              disabled={!canWrite || save.isPending}
              onClick={() => {
                void save
                  .mutateAsync({ body: toBody(form.getValues()), force: "1" })
                  .then(() => onOpenChange(false))
                  .catch(() => undefined);
              }}
            >
              강제 등록
            </Button>
          }
        >
          <ul>
            {gate.map((item) => (
              <li key={item.key}>
                {item.key} — {item.detail}
              </li>
            ))}
          </ul>
        </InlineNotice>
      ) : null}
    </FormDialog>
  );
}
