import { type RefObject } from "react";
import { Controller } from "react-hook-form";
import { useAuth } from "@/app/auth/AuthProvider";
import { FormDialog } from "@/shared/components/form/FormDialog";
import { FormField } from "@/shared/components/form/FormField";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { CodeEditor } from "@/shared/code-editor/CodeEditor";
import { Button } from "@/shared/components/ui/Button";
import { Checkbox } from "@/shared/components/ui/Checkbox";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { Textarea } from "@/shared/components/ui/Textarea";
import type { FeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";
import { DefinitionReview } from "./DefinitionReview";
import { DefinitionSteps } from "./DefinitionSteps";
import {
  definitionDefaults,
  definitionSchema,
  editableDefinition,
  type DefinitionTarget,
} from "./definition-form";
import { definitionError, definitionErrorMessage } from "./definition-messages";
import { useDefinitionReview } from "./use-definition-review";
import { useDefinitionWrite } from "./use-definition-write";
import "./definition.css";

export function DefinitionDialog({
  owner,
  target,
  close,
  returnFocusRef,
}: {
  owner: FeatureReadOwner;
  target: DefinitionTarget;
  close: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}) {
  const auth = useAuth();
  const form = useZodForm(definitionSchema, definitionDefaults(target));
  const review = useDefinitionReview(form, target);
  const write = useDefinitionWrite(owner, target);
  const editable = editableDefinition(target, auth.credentialPrefixes);
  const errors = form.formState.errors;
  const editorDisabled = !write.allowed || write.uncertain || !editable || form.formState.isSubmitting;
  const title = `${target.kind === "prompt" ? "기준 프롬프트" : "검증 워크플로"} ${target.original ? "편집" : "추가"}`;
  return (
    <FormDialog
      open
      title={title}
      description="회귀 검사의 이름, 입력과 기대 내용을 정의합니다."
      form={form}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      returnFocusRef={returnFocusRef}
      scrollBody
      scrollHint="입력과 변경 비교 영역을 스크롤해 확인하세요."
      errorFormatter={definitionErrorMessage}
      submitLabel={write.uncertain ? "저장 결과 확인" : target.original ? "수정 저장" : "정의 등록"}
      submitDisabled={!write.allowed || !editable || (!write.uncertain && !review.confirmed)}
      onSubmit={async (values) => {
        if (!editable) throw definitionError("golden_review");
        if (!write.uncertain) review.assertReviewed(values);
        await write.submit(values);
      }}
    >
      {!write.allowed ? <InlineNotice tone="warning">{write.reason} 초안은 유지됩니다.</InlineNotice> : null}
      {!editable ? (
        <InlineNotice tone="warning">
          원본 일부가 숨겨져 있거나 단계 정보를 확인할 수 없어 편집할 수 없습니다.
        </InlineNotice>
      ) : null}
      {write.uncertain ? (
        <InlineNotice tone="warning" title="저장 상태 확인 필요">
          전송한 초안을 유지했습니다. 아래 버튼은 현재 정의를 조회해 전송한 내용과 비교합니다. 저장 요청을
          다시 보내지 않습니다.
        </InlineNotice>
      ) : null}
      <fieldset
        className="regression-editor-fields"
        disabled={!write.allowed || write.uncertain || !editable}
      >
        <FormField label="이름" required error={errors.name?.message}>
          {(control) => <Input {...control} {...form.register("name")} />}
        </FormField>
        {target.kind === "prompt" ? (
          <>
            <FormField label="기준 프롬프트" required error={errors.prompt?.message}>
              {(control) => (
                <Controller
                  control={form.control}
                  name="prompt"
                  render={({ field }) => (
                    <CodeEditor
                      {...control}
                      {...field}
                      value={field.value ?? ""}
                      label="기준 프롬프트"
                      language="prompt"
                      rows={6}
                      disabled={editorDisabled}
                    />
                  )}
                />
              )}
            </FormField>
            <FormField
              label="기대 내용"
              description="비워 두면 기존 문자열 검사는 점수 0으로도 통과할 수 있습니다. 공백은 그대로 저장합니다."
              error={errors.expected?.message}
            >
              {(control) => (
                <Controller
                  control={form.control}
                  name="expected"
                  render={({ field }) => (
                    <CodeEditor
                      {...control}
                      {...field}
                      value={field.value ?? ""}
                      label="기대 내용"
                      language="prompt"
                      rows={4}
                      disabled={editorDisabled}
                    />
                  )}
                />
              )}
            </FormField>
          </>
        ) : (
          <FormField label="설명" error={errors.description?.message}>
            {(control) => <Textarea {...control} rows={3} {...form.register("description")} />}
          </FormField>
        )}
        <FormField
          label="태그 (JSON 문자열 배열)"
          description={'예: ["한글", "회귀"]. 쉼표와 공백을 포함한 태그도 그대로 유지합니다.'}
          error={errors.tags?.message}
        >
          {(control) => (
            <Controller
              control={form.control}
              name="tags"
              render={({ field }) => (
                <CodeEditor
                  {...control}
                  {...field}
                  value={field.value ?? ""}
                  label="태그 (JSON 문자열 배열)"
                  language="json"
                  rows={3}
                  disabled={editorDisabled}
                />
              )}
            />
          )}
        </FormField>
        {target.kind === "workflow" ? <DefinitionSteps form={form} disabled={editorDisabled} /> : null}
        <Button onClick={() => void review.review()}>변경 내용 검토</Button>
        {review.values ? (
          <>
            <DefinitionReview target={target} values={review.values} prefixes={auth.credentialPrefixes} />
            <Checkbox
              label="변경 내용과 다음 검사에 반영될 범위를 확인했습니다."
              checked={review.confirmed}
              onChange={(event) => review.confirm(event.target.checked)}
            />
          </>
        ) : null}
      </fieldset>
    </FormDialog>
  );
}
