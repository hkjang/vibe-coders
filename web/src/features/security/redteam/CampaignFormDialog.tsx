import { useEffect, useMemo, type RefObject } from "react";

import {
  campaignFormSchema,
  type CampaignDraft,
  type CampaignFormInput,
  type CampaignFormValues,
} from "@/features/security/redteam/campaign-draft";
import { campaignScopes, destructivePolicies, executionModes } from "@/features/security/redteam/redteam-ui";
import type { RedTeamProbePack, RedTeamTarget } from "@/shared/api/domains/redteam";
import { FormDialog } from "@/shared/components/form/FormDialog";
import { FormField } from "@/shared/components/form/FormField";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { Badge } from "@/shared/components/ui/Badge";
import { Input } from "@/shared/components/ui/Input";
import { Select } from "@/shared/components/ui/Select";

interface CampaignFormDialogProps {
  draft: CampaignDraft;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: CampaignFormValues, campaignId: string) => Promise<unknown>;
  open: boolean;
  packs: readonly RedTeamProbePack[];
  returnFocusRef: RefObject<HTMLElement | null>;
  targets: readonly RedTeamTarget[];
}

export function CampaignFormDialog({
  draft,
  onOpenChange,
  onSubmit,
  open,
  packs,
  returnFocusRef,
  targets,
}: CampaignFormDialogProps): React.JSX.Element {
  const form = useZodForm<CampaignFormInput, CampaignFormValues>(campaignFormSchema, draft.values);
  const { reset } = form;
  useEffect(() => {
    if (open) reset(draft.values);
  }, [draft, open, reset]);

  const providers = useMemo(
    () =>
      [
        ...new Set(
          targets
            .filter((target) => target.target_type === "provider" && target.provider !== "")
            .map((target) => target.provider),
        ),
      ].sort((left, right) => left.localeCompare(right)),
    [targets],
  );
  const selectedProvider = form.watch("provider");
  const modelTargets = useMemo(
    () =>
      targets.filter(
        (target) =>
          target.target_type === "model" &&
          target.model !== "" &&
          (selectedProvider === "" || target.provider === selectedProvider),
      ),
    [selectedProvider, targets],
  );
  const errors = form.formState.errors;

  return (
    <FormDialog
      description="테스트할 대상 범위와 프로브 팩, 실행 모드와 안전 한도를 정합니다. 실제 upstream 호출은 실행 모드가 '실제 실행(통제)'일 때만 일어납니다."
      form={form}
      onOpenChange={onOpenChange}
      onSubmit={(values) => onSubmit(values, draft.id)}
      open={open}
      returnFocusRef={returnFocusRef}
      submitLabel={draft.id === "" ? "캠페인 생성" : "수정 저장"}
      title={draft.id === "" ? "캠페인 만들기" : "캠페인 수정"}
    >
      <FormField label="캠페인 이름" required error={errors.name?.message}>
        {(control) => (
          <Input {...control} {...form.register("name")} placeholder="예: 주간-프로바이더-mcp-레드팀" />
        )}
      </FormField>
      <FormField label="범위(scope)" description="테스트할 대상 유형">
        {(control) => (
          <Select {...control} {...form.register("scope")}>
            {campaignScopes.map((scope) => (
              <option key={scope.value} value={scope.value}>
                {scope.label}
              </option>
            ))}
          </Select>
        )}
      </FormField>
      <FormField label="실행 모드" description="실제 호출은 '실제 실행(통제)'에서만 수행됩니다.">
        {(control) => (
          <Select {...control} {...form.register("execution_mode")}>
            {executionModes.map((mode) => (
              <option key={mode.value} value={mode.value}>
                {mode.label}
              </option>
            ))}
          </Select>
        )}
      </FormField>
      <FormField label="프로바이더(선택)" description="특정 업스트림만 대상으로 제한합니다.">
        {(control) => (
          <Select {...control} {...form.register("provider")}>
            <option value="">(전체 프로바이더)</option>
            {providers.map((provider) => (
              <option key={provider} value={provider}>
                {provider}
              </option>
            ))}
          </Select>
        )}
      </FormField>

      <fieldset className="rt-fieldset">
        <legend>모델(다중 선택 가능)</legend>
        <p className="rt-muted">
          여러 개를 고르면 실제 실행 시 모델마다 각각 호출합니다. 비우면 실행 시 /v1/models에서 자동
          선택합니다.
        </p>
        {modelTargets.length === 0 ? (
          <p className="rt-muted">등록된 모델 대상이 없습니다.</p>
        ) : (
          <div className="rt-checklist">
            {modelTargets.map((target) => (
              <label key={target.id} className="checkbox">
                <input type="checkbox" value={target.model} {...form.register("models")} />
                <span className="checkbox-copy">
                  <span>{target.model}</span>
                  {target.provider ? <small>{target.provider}</small> : null}
                </span>
              </label>
            ))}
          </div>
        )}
      </fieldset>

      <FormField
        label="예산 한도(KRW)"
        description="누적 실호출 비용이 넘으면 실행을 자동 중단합니다."
        error={errors.budget_limit_krw?.message}
      >
        {(control) => <Input {...control} {...form.register("budget_limit_krw")} inputMode="decimal" />}
      </FormField>
      <FormField label="QPS 한도" description="대상별 초당 요청 상한" error={errors.qps_limit?.message}>
        {(control) => <Input {...control} {...form.register("qps_limit")} inputMode="decimal" />}
      </FormField>
      <FormField label="파괴적 도구 정책" description="삭제/배포성 MCP 도구 처리 방식">
        {(control) => (
          <Select {...control} {...form.register("destructive_tool_policy")}>
            {destructivePolicies.map((policy) => (
              <option key={policy.value} value={policy.value}>
                {policy.label}
              </option>
            ))}
          </Select>
        )}
      </FormField>

      <label className="checkbox">
        <input type="checkbox" {...form.register("retain_raw_evidence")} />
        <span className="checkbox-copy">
          <span>원문 증적 보관</span>
          <small>실제 실행 시 마스킹하지 않은 요청/응답을 저장합니다. 민감정보 노출에 주의하세요.</small>
        </span>
      </label>

      <fieldset className="rt-fieldset">
        <legend>프로브 팩</legend>
        {errors.probe_pack_ids?.message ? (
          <p className="field-error" role="alert">
            {errors.probe_pack_ids.message}
          </p>
        ) : null}
        {packs.length === 0 ? (
          <p className="rt-muted">프로브 팩이 없습니다.</p>
        ) : (
          <div className="rt-checklist">
            {packs.map((pack) => (
              <label key={pack.id} className="checkbox">
                <input type="checkbox" value={pack.id} {...form.register("probe_pack_ids")} />
                <span className="checkbox-copy">
                  <span>
                    {pack.name} <Badge tone="muted">{pack.severity}</Badge>
                    {pack.requires_approval ? <Badge tone="warning">승인필요</Badge> : null}
                  </span>
                  <small>
                    {pack.category} · 케이스 {pack.cases.length}
                  </small>
                </span>
              </label>
            ))}
          </div>
        )}
      </fieldset>
    </FormDialog>
  );
}
