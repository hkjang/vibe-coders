import { useLayoutEffect } from "react";

import {
  appPermissionDescription,
  appPermissionRevokeDescription,
  appPermissionSchema,
  appPermissionTypes,
  type AppPermissionValues,
} from "./app-permission-form";
import type { AppPermissionDraft, AppPermissionEditor } from "./use-app-permission-draft";
import { FormDialog } from "@/shared/components/form/FormDialog";
import { FormField } from "@/shared/components/form/FormField";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { Select } from "@/shared/components/ui/Select";

export function AppPermissionDialog({
  target,
  editor,
  canWrite,
  writeDisabledReason,
}: {
  target: AppPermissionDraft;
  editor: AppPermissionEditor;
  canWrite: boolean;
  writeDisabledReason: string;
}): React.JSX.Element {
  const form = useZodForm<AppPermissionValues, AppPermissionValues>(
    appPermissionSchema,
    target.subject ?? { subject_type: "user", subject_id: "" },
  );
  const dirty = form.formState.isDirty;
  const { setDirty } = editor;
  useLayoutEffect(() => setDirty(dirty), [dirty, setDirty]);
  const revoke = target.kind === "revoke";
  const subjectLabel = form.watch("subject_type") === "team" ? "팀 ID" : "사용자 ID";

  return (
    <FormDialog
      open
      form={form}
      title={revoke ? "앱 추가 접근 권한 회수" : "앱 접근 권한 추가"}
      description={`${target.app.title || target.app.id} 앱의 추가 접근 권한을 ${revoke ? "회수" : "등록"}합니다.`}
      submitLabel={revoke ? "권한 회수" : "접근 권한 추가"}
      submitDisabled={!canWrite}
      returnFocusRef={editor.returnFocusRef}
      onOpenChange={(next) => {
        if (!next) editor.close(target.instance);
      }}
      onSubmit={(values) => editor.submit(target, values)}
    >
      <InlineNotice tone={revoke ? "warning" : "info"}>
        {revoke ? appPermissionRevokeDescription : appPermissionDescription}
      </InlineNotice>
      <KeyValueList items={[{ label: "앱 ID", value: target.app.id, mono: true }]} />
      {!canWrite ? (
        <InlineNotice tone="info" title="읽기 전용">
          {writeDisabledReason}
        </InlineNotice>
      ) : null}
      {revoke ? (
        <KeyValueList
          items={[
            { label: "대상 종류", value: target.subject?.subject_type === "team" ? "팀" : "사용자" },
            { label: "대상 ID", value: target.subject?.subject_id, mono: true },
          ]}
        />
      ) : (
        <>
          <FormField label="대상 종류" required error={form.formState.errors.subject_type?.message}>
            {(control) => (
              <Select
                {...control}
                {...form.register("subject_type")}
                options={appPermissionTypes}
                disabled={!canWrite}
              />
            )}
          </FormField>
          <FormField
            label={subjectLabel}
            required
            description="이름이나 이메일 대신 저장된 ID를 입력하세요. ID의 존재 여부는 여기서 확인하지 않습니다."
            error={form.formState.errors.subject_id?.message}
          >
            {(control) => <Input {...control} {...form.register("subject_id")} disabled={!canWrite} />}
          </FormField>
        </>
      )}
    </FormDialog>
  );
}
