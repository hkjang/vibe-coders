import type { UseFormReturn } from "react-hook-form";
import type { Text2SQLConnectionRow } from "@/shared/api/domains/text2sql";
import { FormField } from "@/shared/components/form/FormField";
import { Input } from "@/shared/components/ui/Input";
import { Select } from "@/shared/components/ui/Select";
import { Textarea } from "@/shared/components/ui/Textarea";
import type { ProfileFormValues } from "./profile-form";

export function ProfileFormFields({
  form,
  editing,
  connections,
}: {
  form: UseFormReturn<ProfileFormValues, unknown, ProfileFormValues>;
  editing: boolean;
  connections: readonly Text2SQLConnectionRow[];
}): React.JSX.Element {
  const selected = form.watch("exec_connection_id");
  return (
    <>
      <FormField
        label="가상 모델"
        required
        description="예: vibe/text2sql-finance. 저장 후 이름은 변경할 수 없습니다."
        error={form.formState.errors.virtual_model?.message}
      >
        {(control) => <Input {...control} {...form.register("virtual_model")} readOnly={editing} />}
      </FormField>
      <FormField label="모드" required error={form.formState.errors.mode?.message}>
        {(control) => (
          <Select
            {...control}
            {...form.register("mode")}
            options={[
              { value: "preview", label: "미리보기 (SQL 생성만)" },
              { value: "execute", label: "실행 (SQL 조회까지)" },
            ]}
          />
        )}
      </FormField>
      {(
        [
          ["upstream_model", "업스트림 모델"],
          ["summary_model", "요약 모델"],
          ["schema_name", "스키마명"],
        ] as const
      ).map(([key, label]) => (
        <FormField
          key={key}
          label={label}
          description="비워 두면 서버 기본 설정을 사용합니다."
          error={form.formState.errors[key]?.message}
        >
          {(control) => <Input {...control} {...form.register(key)} />}
        </FormField>
      ))}
      <FormField label="실행 DB 연결" error={form.formState.errors.exec_connection_id?.message}>
        {(control) => (
          <Select {...control} {...form.register("exec_connection_id")}>
            <option value="">기본 DB (서버 설정)</option>
            {selected && !connections.some((connection) => connection.id === selected) ? (
              <option value={selected}>
                {selected === "default" ? "기본 DB (서버 설정)" : `${selected} (연결 목록에서 확인되지 않음)`}
              </option>
            ) : null}
            {connections.map((connection) => (
              <option key={connection.id} value={connection.id}>
                {connection.name} · {connection.id}
                {connection.enabled ? "" : " (중지)"}
              </option>
            ))}
          </Select>
        )}
      </FormField>
      <FormField
        label="프로필 적용"
        description="미적용은 이 프로필 대신 서버 기본 설정을 사용합니다. SQL 실행 전체를 중지하지 않습니다."
      >
        {(control) => <input {...control} type="checkbox" {...form.register("enabled")} />}
      </FormField>
      <FormField
        label="변경 사유"
        required
        description="500자 이내로 입력하세요. 비밀번호나 개인정보는 입력하지 마세요."
        error={form.formState.errors.reason?.message}
      >
        {(control) => <Textarea {...control} {...form.register("reason")} rows={3} />}
      </FormField>
    </>
  );
}
