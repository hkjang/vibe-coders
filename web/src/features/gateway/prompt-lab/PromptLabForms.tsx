import { Controller, useWatch } from "react-hook-form";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Checkbox } from "@/shared/components/ui/Checkbox";
import { Input } from "@/shared/components/ui/Input";
import { Select } from "@/shared/components/ui/Select";
import { Textarea } from "@/shared/components/ui/Textarea";
import { FormDialog } from "@/shared/components/form/FormDialog";
import { FormField } from "@/shared/components/form/FormField";
import { CodeEditor } from "@/shared/code-editor/CodeEditor";
import type { PromptLabController } from "./use-prompt-lab-controller";
import { contractTypes, contractTypeLabels } from "./prompt-lab-form";
export function PromptLabForms({ lab }: { lab: PromptLabController }) {
  const {
    contracts,
    rubrics,
    experimentOpen,
    setExperimentOpen,
    contractOpen,
    setContractOpen,
    rubricOpen,
    setRubricOpen,
    testCaseOpen,
    setTestCaseOpen,
    returnFocusRef,
    experimentForm,
    contractForm,
    rubricForm,
    testCaseForm,
    createExperiment,
    createContract,
    createRubric,
    createTestCase,
  } = lab;
  const contractType = useWatch({ control: contractForm.control, name: "type" });
  return (
    <>
      <FormDialog
        open={experimentOpen}
        onOpenChange={setExperimentOpen}
        returnFocusRef={returnFocusRef}
        form={experimentForm}
        title="실험 만들기"
        description="실험은 테스트 케이스를 묶는 단위입니다."
        onSubmit={(values) => createExperiment.mutateAsync(values)}
        scrollBody
        submitDisabled={!lab.canWrite || createExperiment.uncertain}
      >
        {!lab.canWrite ? <InlineNotice tone="warning">{lab.writeDeniedReason}</InlineNotice> : null}
        {createExperiment.uncertain ? (
          <InlineNotice tone="warning">
            이전 요청이 처리되었을 수 있습니다. 현재 저장 내용과 감사 이력을 확인한 뒤 새 작업을 시작하세요.
            자동 재전송하지 않습니다.
          </InlineNotice>
        ) : null}
        <FormField label="제목" required error={experimentForm.formState.errors.title?.message}>
          {(control) => <Input {...control} {...experimentForm.register("title")} />}
        </FormField>
        <FormField label="설명">
          {(control) => <Textarea {...control} rows={3} {...experimentForm.register("description")} />}
        </FormField>
        <FormField label="팀" description="비우면 내 팀으로 저장합니다.">
          {(control) => <Input {...control} {...experimentForm.register("team")} />}
        </FormField>
      </FormDialog>

      <FormDialog
        open={contractOpen}
        onOpenChange={setContractOpen}
        returnFocusRef={returnFocusRef}
        form={contractForm}
        title="출력 계약 추가"
        description="응답이 만족해야 하는 형식을 정의합니다."
        onSubmit={(values) => createContract.mutateAsync(values)}
        scrollBody
        scrollHint="계약 내용을 위아래로 스크롤해 확인할 수 있습니다."
        submitDisabled={!lab.canWrite || createContract.uncertain}
      >
        {!lab.canWrite ? <InlineNotice tone="warning">{lab.writeDeniedReason}</InlineNotice> : null}
        {createContract.uncertain ? (
          <InlineNotice tone="warning">
            이전 요청이 처리되었을 수 있습니다. 현재 저장 내용과 감사 이력을 확인한 뒤 새 작업을 시작하세요.
            자동 재전송하지 않습니다.
          </InlineNotice>
        ) : null}
        <FormField label="이름" required error={contractForm.formState.errors.name?.message}>
          {(control) => <Input {...control} {...contractForm.register("name")} />}
        </FormField>
        <FormField label="유형" required>
          {(control) => (
            <Select
              {...control}
              {...contractForm.register("type")}
              options={contractTypes.map((type) => ({ value: type, label: contractTypeLabels[type] }))}
            />
          )}
        </FormField>
        <FormField
          label="스키마 / 정규식"
          description="JSON 스키마(required, properties) 또는 정규식 패턴을 입력합니다."
          error={contractForm.formState.errors.schema_json?.message}
        >
          {(control) => (
            <Controller
              control={contractForm.control}
              name="schema_json"
              render={({ field }) => (
                <CodeEditor
                  {...control}
                  {...field}
                  value={field.value ?? ""}
                  label="스키마 / 정규식"
                  language={contractType === "json" || contractType === "json_schema" ? "json" : "prompt"}
                  rows={5}
                  disabled={!lab.canWrite || createContract.uncertain || contractForm.formState.isSubmitting}
                />
              )}
            />
          )}
        </FormField>
        <Checkbox
          label="엄격 모드"
          description="현재 실행기는 형식 위반 시 통과 판정을 주의로 낮춥니다."
          {...contractForm.register("strict")}
        />
      </FormDialog>

      <FormDialog
        open={rubricOpen}
        onOpenChange={setRubricOpen}
        returnFocusRef={returnFocusRef}
        form={rubricForm}
        title="평가 기준 추가"
        description="채점 기준을 JSON으로 저장합니다."
        onSubmit={(values) => createRubric.mutateAsync(values)}
        scrollBody
        scrollHint="평가 기준을 위아래로 스크롤해 확인할 수 있습니다."
        submitDisabled={!lab.canWrite || createRubric.uncertain}
      >
        {!lab.canWrite ? <InlineNotice tone="warning">{lab.writeDeniedReason}</InlineNotice> : null}
        {createRubric.uncertain ? (
          <InlineNotice tone="warning">
            이전 요청이 처리되었을 수 있습니다. 현재 저장 내용과 감사 이력을 확인한 뒤 새 작업을 시작하세요.
            자동 재전송하지 않습니다.
          </InlineNotice>
        ) : null}
        <FormField label="이름" required error={rubricForm.formState.errors.name?.message}>
          {(control) => <Input {...control} {...rubricForm.register("name")} />}
        </FormField>
        <FormField
          label="기준(JSON)"
          error={rubricForm.formState.errors.criteria_json?.message}
          description='예: {"accuracy": 0.4, "completeness": 0.3}'
        >
          {(control) => (
            <Controller
              control={rubricForm.control}
              name="criteria_json"
              render={({ field }) => (
                <CodeEditor
                  {...control}
                  {...field}
                  value={field.value ?? ""}
                  label="기준(JSON)"
                  language="json"
                  rows={5}
                  disabled={!lab.canWrite || createRubric.uncertain || rubricForm.formState.isSubmitting}
                />
              )}
            />
          )}
        </FormField>
      </FormDialog>

      <FormDialog
        open={testCaseOpen}
        onOpenChange={setTestCaseOpen}
        returnFocusRef={returnFocusRef}
        form={testCaseForm}
        title="테스트 케이스 추가"
        description="프롬프트와 기본 모델 집합을 저장합니다. 프롬프트 원문은 서버에 저장되므로 비밀값을 넣지 마세요."
        onSubmit={(values) => createTestCase.mutateAsync(values)}
        scrollBody
        scrollHint="프롬프트와 검사 조건을 위아래로 스크롤해 확인할 수 있습니다."
        submitDisabled={!lab.canWrite || createTestCase.uncertain}
      >
        {!lab.canWrite ? <InlineNotice tone="warning">{lab.writeDeniedReason}</InlineNotice> : null}
        {createTestCase.uncertain ? (
          <InlineNotice tone="warning">
            이전 요청이 처리되었을 수 있습니다. 현재 저장 내용과 감사 이력을 확인한 뒤 새 작업을 시작하세요.
            자동 재전송하지 않습니다.
          </InlineNotice>
        ) : null}
        <FormField label="이름" required error={testCaseForm.formState.errors.name?.message}>
          {(control) => <Input {...control} {...testCaseForm.register("name")} />}
        </FormField>
        <FormField label="모델" description="쉼표로 구분해 입력합니다.">
          {(control) => <Input {...control} {...testCaseForm.register("models")} />}
        </FormField>
        <FormField label="출력 계약">
          {(control) => (
            <Select {...control} {...testCaseForm.register("contract_id")}>
              <option value="">선택 안 함</option>
              {(contracts.data?.contracts ?? []).map((contract) => (
                <option key={contract.id} value={contract.id}>
                  {contract.name}
                </option>
              ))}
            </Select>
          )}
        </FormField>
        <FormField label="평가 기준">
          {(control) => (
            <Select {...control} {...testCaseForm.register("rubric_id")}>
              <option value="">선택 안 함</option>
              {(rubrics.data?.rubrics ?? []).map((rubric) => (
                <option key={rubric.id} value={rubric.id}>
                  {rubric.name}
                </option>
              ))}
            </Select>
          )}
        </FormField>
        <FormField label="시스템 프롬프트" error={testCaseForm.formState.errors.system?.message}>
          {(control) => (
            <Controller
              control={testCaseForm.control}
              name="system"
              render={({ field }) => (
                <CodeEditor
                  {...control}
                  {...field}
                  value={field.value ?? ""}
                  label="시스템 프롬프트"
                  language="prompt"
                  rows={3}
                  disabled={!lab.canWrite || createTestCase.uncertain || testCaseForm.formState.isSubmitting}
                />
              )}
            />
          )}
        </FormField>
        <FormField label="사용자 프롬프트" required error={testCaseForm.formState.errors.user?.message}>
          {(control) => (
            <Controller
              control={testCaseForm.control}
              name="user"
              render={({ field }) => (
                <CodeEditor
                  {...control}
                  {...field}
                  label="사용자 프롬프트"
                  language="prompt"
                  rows={5}
                  disabled={!lab.canWrite || createTestCase.uncertain || testCaseForm.formState.isSubmitting}
                />
              )}
            />
          )}
        </FormField>
      </FormDialog>
    </>
  );
}
