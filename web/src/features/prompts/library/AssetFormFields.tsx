import { Controller, type UseFormReturn } from "react-hook-form";
import { FormField } from "@/shared/components/form/FormField";
import { Input } from "@/shared/components/ui/Input";
import { Select } from "@/shared/components/ui/Select";
import { Textarea } from "@/shared/components/ui/Textarea";
import { CodeEditor } from "@/shared/code-editor/CodeEditor";
import { assetStatuses, type AssetFormValues } from "./asset-form";
import { assetStatusLabel } from "./prompt-utils";
export function AssetFormFields({
  form,
  editing,
  categories,
  editorDisabled,
}: {
  form: UseFormReturn<AssetFormValues, unknown, AssetFormValues>;
  editing: boolean;
  categories: readonly { key: string; label?: string }[];
  editorDisabled: boolean;
}) {
  return (
    <>
      <FormField label="이름" required error={form.formState.errors.name?.message}>
        {(control) => <Input {...control} {...form.register("name")} />}
      </FormField>
      <FormField
        label="식별자 (ID)"
        description="영문 소문자·숫자·밑줄·하이픈으로 정리됩니다. 한글 이름은 영문 ID를 함께 입력하세요. 기존 ID는 편집 기능에서 수정합니다."
        error={form.formState.errors.id?.message}
      >
        {(control) => <Input {...control} {...form.register("id")} readOnly={editing} />}
      </FormField>
      <FormField label="분류" error={form.formState.errors.category?.message}>
        {(control) => (
          <Select {...control} {...form.register("category")}>
            {(categories.length > 0 ? categories : [{ key: "custom", label: "기타" }]).map((category) => (
              <option key={category.key} value={category.key}>
                {category.label ?? category.key}
              </option>
            ))}
          </Select>
        )}
      </FormField>
      {editing ? null : (
        <FormField
          label="상태"
          description="등록 후에는 검토 제출·승인 흐름으로만 상태가 바뀝니다."
          error={form.formState.errors.status?.message}
        >
          {(control) => (
            <Select {...control} {...form.register("status")}>
              {assetStatuses.map((status) => (
                <option key={status} value={status}>
                  {assetStatusLabel(status)}
                </option>
              ))}
            </Select>
          )}
        </FormField>
      )}
      <FormField
        label="태그"
        description="쉼표로 구분합니다. 예: security, java"
        error={form.formState.errors.tags?.message}
      >
        {(control) => <Input {...control} {...form.register("tags")} />}
      </FormField>
      <FormField label="설명" error={form.formState.errors.description?.message}>
        {(control) => <Textarea {...control} rows={2} {...form.register("description")} />}
      </FormField>
      <FormField label="프롬프트 본문" required error={form.formState.errors.body?.message}>
        {(control) => (
          <Controller
            control={form.control}
            name="body"
            render={({ field }) => (
              <CodeEditor
                {...control}
                {...field}
                label="프롬프트 본문"
                language="prompt"
                rows={8}
                disabled={editorDisabled}
              />
            )}
          />
        )}
      </FormField>
      <FormField label="노트" error={form.formState.errors.note?.message}>
        {(control) => <Input {...control} {...form.register("note")} />}
      </FormField>
    </>
  );
}
