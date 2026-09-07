import { useRef, useState } from "react";
import { FlaskConical, Plus, Trash2 } from "lucide-react";
import { z } from "zod";

import { useAuth } from "@/app/auth/AuthProvider";
import "@/features/gateway/gateway.css";
import {
  promptLabKeys,
  promptLabRouteId,
  usePromptContracts,
  usePromptExperimentDetail,
  usePromptExperiments,
  usePromptRubrics,
} from "@/features/gateway/prompt-lab/use-prompt-lab";
import { apiClient } from "@/shared/api/client";
import { withGatewayPathParams } from "@/shared/api/domains/gateway";
import { endpoints } from "@/shared/api/endpoints";
import { PageHeader } from "@/shared/components/page/PageHeader";
import { LoadingState } from "@/shared/components/state/PageStates";
import { Button } from "@/shared/components/ui/Button";
import { Checkbox } from "@/shared/components/ui/Checkbox";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { TabPanel, Tabs, type TabItem } from "@/shared/components/ui/Tabs";
import { Textarea } from "@/shared/components/ui/Textarea";
import { FormDialog } from "@/shared/components/form/FormDialog";
import { FormField } from "@/shared/components/form/FormField";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { useTabParam } from "@/shared/hooks/use-tab-param";
import { formatDateTime } from "@/shared/utils/format";

const lab = endpoints.domains.gateway.promptLab;

const tabIds = ["experiments", "contracts", "rubrics"] as const;
type PromptLabTabId = (typeof tabIds)[number];

const tabs: ReadonlyArray<TabItem<PromptLabTabId>> = [
  { id: "experiments", label: "실험" },
  { id: "contracts", label: "출력 계약" },
  { id: "rubrics", label: "평가 루브릭" },
];

const experimentSchema = z.object({
  title: z.string().trim().min(1, "실험 제목을 입력하세요.").max(200),
  description: z.string().trim().max(1000).default(""),
  team: z.string().trim().max(120).default(""),
});
type ExperimentInput = z.input<typeof experimentSchema>;
type ExperimentOutput = z.output<typeof experimentSchema>;

const contractTypes = ["json", "json_schema", "markdown_table", "sql", "regex"] as const;
const contractSchema = z.object({
  name: z.string().trim().min(1, "계약 이름을 입력하세요.").max(200),
  type: z.enum(contractTypes),
  schema_json: z.string().trim().max(20_000).default(""),
  strict: z.boolean().default(false),
});
type ContractInput = z.input<typeof contractSchema>;
type ContractOutput = z.output<typeof contractSchema>;

const rubricSchema = z.object({
  name: z.string().trim().min(1, "루브릭 이름을 입력하세요.").max(200),
  criteria_json: z
    .string()
    .trim()
    .max(20_000)
    .default("")
    .refine((value) => {
      if (value === "") return true;
      try {
        JSON.parse(value);
        return true;
      } catch {
        return false;
      }
    }, "올바른 JSON이 아닙니다."),
});
type RubricInput = z.input<typeof rubricSchema>;
type RubricOutput = z.output<typeof rubricSchema>;

const testCaseSchema = z.object({
  name: z.string().trim().min(1, "테스트 케이스 이름을 입력하세요.").max(200),
  models: z.string().trim().max(500).default(""),
  contract_id: z.string().trim().max(120).default(""),
  rubric_id: z.string().trim().max(120).default(""),
  system: z.string().max(20_000).default(""),
  user: z.string().trim().min(1, "사용자 프롬프트를 입력하세요.").max(20_000),
});
type TestCaseInput = z.input<typeof testCaseSchema>;
type TestCaseOutput = z.output<typeof testCaseSchema>;

const contractTypeLabels: Record<(typeof contractTypes)[number], string> = {
  json: "JSON",
  json_schema: "JSON 스키마",
  markdown_table: "마크다운 표",
  sql: "읽기 전용 SQL",
  regex: "정규식",
};

export function PromptLabPage(): React.JSX.Element {
  const auth = useAuth();
  const canWrite = auth.user?.scopes.includes("admin:write") ?? false;
  const writeDeniedReason = "이 작업은 admin:write 권한이 필요합니다. 관리자에게 권한을 요청하세요.";
  const [tab, setTab] = useTabParam<PromptLabTabId>(tabIds);
  const [params, updateParams] = useSearchState();
  const selectedExperiment = params.get("exp") ?? "";

  const experiments = usePromptExperiments();
  const contracts = usePromptContracts();
  const rubrics = usePromptRubrics();
  const detail = usePromptExperimentDetail(selectedExperiment);

  const [experimentOpen, setExperimentOpen] = useState(false);
  const [contractOpen, setContractOpen] = useState(false);
  const [rubricOpen, setRubricOpen] = useState(false);
  const [testCaseOpen, setTestCaseOpen] = useState(false);
  const [removeCase, setRemoveCase] = useState<{ id: string; name: string } | undefined>();
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const newExperimentRef = useRef<HTMLButtonElement>(null);
  const newContractRef = useRef<HTMLButtonElement>(null);
  const newRubricRef = useRef<HTMLButtonElement>(null);
  const newTestCaseRef = useRef<HTMLButtonElement>(null);

  const experimentForm = useZodForm<ExperimentInput, ExperimentOutput>(experimentSchema, {
    title: "",
    description: "",
    team: "",
  });
  const contractForm = useZodForm<ContractInput, ContractOutput>(contractSchema, {
    name: "",
    type: "json",
    schema_json: "",
    strict: false,
  });
  const rubricForm = useZodForm<RubricInput, RubricOutput>(rubricSchema, {
    name: "",
    criteria_json: "",
  });
  const testCaseForm = useZodForm<TestCaseInput, TestCaseOutput>(testCaseSchema, {
    name: "",
    models: "",
    contract_id: "",
    rubric_id: "",
    system: "",
    user: "",
  });

  const createExperiment = useMutationFeedback({
    mutate: (values: ExperimentOutput) =>
      apiClient.request(lab.experiments.create, {
        body: {
          title: values.title,
          description: values.description || undefined,
          team: values.team || undefined,
        },
        routeId: promptLabRouteId,
      }),
    invalidates: [promptLabKeys.experiments],
    successMessage: "실험을 만들었습니다.",
    errorMessage: "실험을 만들지 못했습니다.",
  });

  const createContract = useMutationFeedback({
    mutate: (values: ContractOutput) =>
      apiClient.request(lab.contracts.create, {
        body: {
          name: values.name,
          type: values.type,
          schema_json: values.schema_json || undefined,
          strict: values.strict,
        },
        routeId: promptLabRouteId,
      }),
    invalidates: [promptLabKeys.contracts],
    successMessage: "출력 계약을 저장했습니다.",
    errorMessage: "출력 계약을 저장하지 못했습니다.",
  });

  const createRubric = useMutationFeedback({
    mutate: (values: RubricOutput) =>
      apiClient.request(lab.rubrics.create, {
        body: {
          name: values.name,
          criteria: values.criteria_json === "" ? undefined : (JSON.parse(values.criteria_json) as unknown),
        },
        routeId: promptLabRouteId,
      }),
    invalidates: [promptLabKeys.rubrics],
    successMessage: "평가 루브릭을 저장했습니다.",
    errorMessage: "평가 루브릭을 저장하지 못했습니다.",
  });

  const createTestCase = useMutationFeedback({
    mutate: (values: TestCaseOutput) =>
      apiClient.request(lab.testCases.create, {
        body: {
          experiment_id: selectedExperiment,
          name: values.name,
          messages: [
            ...(values.system.trim() === "" ? [] : [{ role: "system", content: values.system }]),
            { role: "user", content: values.user },
          ],
          contract_id: values.contract_id || undefined,
          rubric_id: values.rubric_id || undefined,
          models: values.models
            .split(",")
            .map((item) => item.trim())
            .filter((item) => item !== ""),
        },
        routeId: promptLabRouteId,
      }),
    invalidates: [promptLabKeys.experiment(selectedExperiment)],
    successMessage: "테스트 케이스를 추가했습니다.",
    errorMessage: "테스트 케이스를 추가하지 못했습니다.",
  });

  const deleteTestCase = useMutationFeedback({
    mutate: (id: string) =>
      apiClient.request(withGatewayPathParams(lab.testCases.remove, { id }), {
        routeId: promptLabRouteId,
      }),
    invalidates: [promptLabKeys.experiment(selectedExperiment)],
    successMessage: "테스트 케이스를 삭제했습니다.",
    errorMessage: "테스트 케이스를 삭제하지 못했습니다.",
  });

  const openDialog = (
    trigger: React.RefObject<HTMLButtonElement | null>,
    setOpen: (open: boolean) => void,
  ): void => {
    returnFocusRef.current = trigger.current;
    setOpen(true);
  };

  return (
    <div className="page-stack">
      <PageHeader
        title="프롬프트 실험실"
        status="preview"
        description="프롬프트 실험과 테스트 케이스, 출력 계약과 평가 루브릭을 관리합니다."
        legacyHref="/admin#/prompt-lab"
      />

      <Tabs
        ariaLabel="프롬프트 실험실 화면"
        items={tabs}
        onChange={setTab}
        panelIdPrefix="prompt-lab"
        value={tab}
      />

      <TabPanel id={tab} panelIdPrefix="prompt-lab">
        {tab === "experiments" ? (
          <div className="page-stack">
            <SectionCard
              title="실험"
              description="같은 목적을 가진 테스트 케이스를 묶는 단위입니다."
              actions={
                <Button
                  ref={newExperimentRef}
                  size="small"
                  variant="primary"
                  disabled={!canWrite}
                  title={canWrite ? undefined : writeDeniedReason}
                  onClick={() => {
                    experimentForm.reset({ title: "", description: "", team: "" });
                    openDialog(newExperimentRef, setExperimentOpen);
                  }}
                >
                  <Plus aria-hidden="true" /> 실험 만들기
                </Button>
              }
            >
              {!canWrite ? (
                <InlineNotice tone="warning" title="쓰기 권한이 없습니다.">
                  {writeDeniedReason}
                </InlineNotice>
              ) : null}
              {experiments.isPending ? (
                <LoadingState label="실험 목록을 불러오는 중입니다." />
              ) : experiments.isError ? (
                <InlineNotice tone="danger" title="실험 목록을 불러오지 못했습니다.">
                  {safeAppErrorMessage(experiments.error, "권한 또는 네트워크 상태를 확인하세요.")}
                  <Button size="small" variant="ghost" onClick={() => void experiments.refetch()}>
                    다시 시도
                  </Button>
                </InlineNotice>
              ) : experiments.data.experiments.length === 0 ? (
                <EmptyState
                  icon={<FlaskConical aria-hidden="true" />}
                  title="등록된 실험이 없습니다."
                  description="실험을 만들면 테스트 케이스를 저장하고 모델별 회귀 비교를 반복할 수 있습니다."
                />
              ) : (
                <div className="data-table-scroll" tabIndex={0} aria-label="프롬프트 실험 표 영역">
                  <table className="data-table">
                    <caption className="sr-only">등록된 프롬프트 실험</caption>
                    <thead>
                      <tr>
                        <th scope="col">제목</th>
                        <th scope="col">팀</th>
                        <th scope="col">담당자</th>
                        <th scope="col">상태</th>
                        <th scope="col">생성 시각</th>
                        <th scope="col">작업</th>
                      </tr>
                    </thead>
                    <tbody>
                      {experiments.data.experiments.map((experiment) => (
                        <tr key={experiment.id}>
                          <td>{experiment.title}</td>
                          <td>{experiment.team || "-"}</td>
                          <td>{experiment.owner || "-"}</td>
                          <td>{experiment.status === "archived" ? "보관" : "진행 중"}</td>
                          <td>{formatDateTime(experiment.created_at)}</td>
                          <td>
                            <Button
                              size="small"
                              variant="ghost"
                              onClick={() => updateParams({ exp: experiment.id })}
                            >
                              테스트 케이스 보기
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </SectionCard>

            {selectedExperiment !== "" ? (
              <SectionCard
                title="테스트 케이스"
                description={
                  detail.data?.experiment?.title
                    ? `실험: ${detail.data.experiment.title}`
                    : "선택한 실험의 저장된 프롬프트입니다."
                }
                actions={
                  <div className="gateway-row-actions">
                    <Button
                      ref={newTestCaseRef}
                      size="small"
                      variant="primary"
                      disabled={!canWrite}
                      title={canWrite ? undefined : writeDeniedReason}
                      onClick={() => {
                        testCaseForm.reset({
                          name: "",
                          models: "",
                          contract_id: "",
                          rubric_id: "",
                          system: "",
                          user: "",
                        });
                        openDialog(newTestCaseRef, setTestCaseOpen);
                      }}
                    >
                      <Plus aria-hidden="true" /> 테스트 케이스 추가
                    </Button>
                    <Button size="small" variant="ghost" onClick={() => updateParams({ exp: undefined })}>
                      닫기
                    </Button>
                  </div>
                }
              >
                <InlineNotice tone="info" title="실행은 기존 화면에서 진행합니다.">
                  테스트 케이스 실행(POST /admin/prompt-lab/test-cases/&#123;id&#125;/run)은 아직 공개된 API
                  계약에 없어 이 화면에서 제공하지 않습니다. 기존 화면에서 실행하세요.
                </InlineNotice>
                {detail.isPending ? (
                  <LoadingState label="테스트 케이스를 불러오는 중입니다." />
                ) : detail.isError ? (
                  <InlineNotice tone="danger" title="테스트 케이스를 불러오지 못했습니다.">
                    {safeAppErrorMessage(detail.error, "권한 또는 네트워크 상태를 확인하세요.")}
                  </InlineNotice>
                ) : detail.data.test_cases.length === 0 ? (
                  <EmptyState
                    title="테스트 케이스가 없습니다."
                    description="자주 쓰는 프롬프트를 저장하면 모델을 바꿀 때마다 같은 조건으로 비교할 수 있습니다."
                  />
                ) : (
                  <div className="data-table-scroll" tabIndex={0} aria-label="테스트 케이스 표 영역">
                    <table className="data-table">
                      <caption className="sr-only">선택한 실험의 테스트 케이스</caption>
                      <thead>
                        <tr>
                          <th scope="col">이름</th>
                          <th scope="col">모델</th>
                          <th scope="col">출력 계약</th>
                          <th scope="col">생성 시각</th>
                          <th scope="col">작업</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.data.test_cases.map((testCase) => (
                          <tr key={testCase.id}>
                            <td>{testCase.name}</td>
                            <td className="truncate">{testCase.models_json || "-"}</td>
                            <td>{testCase.contract_id || "-"}</td>
                            <td>{formatDateTime(testCase.created_at)}</td>
                            <td>
                              <Button
                                size="small"
                                variant="ghost"
                                disabled={!canWrite}
                                title={canWrite ? undefined : writeDeniedReason}
                                onClick={() => setRemoveCase({ id: testCase.id, name: testCase.name })}
                              >
                                <Trash2 aria-hidden="true" /> 삭제
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </SectionCard>
            ) : null}
          </div>
        ) : null}

        {tab === "contracts" ? (
          <SectionCard
            title="출력 계약"
            description="모델 응답이 만족해야 하는 형식을 정의합니다. 테스트 케이스가 이 계약으로 자동 검증됩니다."
            actions={
              <Button
                ref={newContractRef}
                size="small"
                variant="primary"
                disabled={!canWrite}
                title={canWrite ? undefined : writeDeniedReason}
                onClick={() => {
                  contractForm.reset({ name: "", type: "json", schema_json: "", strict: false });
                  openDialog(newContractRef, setContractOpen);
                }}
              >
                <Plus aria-hidden="true" /> 계약 추가
              </Button>
            }
          >
            {contracts.isPending ? (
              <LoadingState label="출력 계약을 불러오는 중입니다." />
            ) : contracts.isError ? (
              <InlineNotice tone="danger" title="출력 계약을 불러오지 못했습니다.">
                {safeAppErrorMessage(contracts.error, "권한 또는 네트워크 상태를 확인하세요.")}
              </InlineNotice>
            ) : contracts.data.contracts.length === 0 ? (
              <EmptyState
                title="등록된 출력 계약이 없습니다."
                description="JSON 스키마나 표 형식을 계약으로 등록하면 응답 형식 위반을 자동으로 잡아냅니다."
              />
            ) : (
              <div className="data-table-scroll" tabIndex={0} aria-label="출력 계약 표 영역">
                <table className="data-table">
                  <caption className="sr-only">등록된 출력 계약</caption>
                  <thead>
                    <tr>
                      <th scope="col">이름</th>
                      <th scope="col">유형</th>
                      <th scope="col">엄격 모드</th>
                      <th scope="col">생성 시각</th>
                    </tr>
                  </thead>
                  <tbody>
                    {contracts.data.contracts.map((contract) => (
                      <tr key={contract.id}>
                        <td>{contract.name}</td>
                        <td>{contract.type || "-"}</td>
                        <td>{contract.strict ? "사용" : "미사용"}</td>
                        <td>{formatDateTime(contract.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>
        ) : null}

        {tab === "rubrics" ? (
          <SectionCard
            title="평가 루브릭"
            description="응답 품질을 채점할 기준을 JSON으로 저장합니다."
            actions={
              <Button
                ref={newRubricRef}
                size="small"
                variant="primary"
                disabled={!canWrite}
                title={canWrite ? undefined : writeDeniedReason}
                onClick={() => {
                  rubricForm.reset({ name: "", criteria_json: "" });
                  openDialog(newRubricRef, setRubricOpen);
                }}
              >
                <Plus aria-hidden="true" /> 루브릭 추가
              </Button>
            }
          >
            {rubrics.isPending ? (
              <LoadingState label="평가 루브릭을 불러오는 중입니다." />
            ) : rubrics.isError ? (
              <InlineNotice tone="danger" title="평가 루브릭을 불러오지 못했습니다.">
                {safeAppErrorMessage(rubrics.error, "권한 또는 네트워크 상태를 확인하세요.")}
              </InlineNotice>
            ) : rubrics.data.rubrics.length === 0 ? (
              <EmptyState
                title="등록된 루브릭이 없습니다."
                description="정확성·완결성 같은 채점 기준을 저장하면 자동 평가에서 재사용할 수 있습니다."
              />
            ) : (
              <div className="data-table-scroll" tabIndex={0} aria-label="평가 루브릭 표 영역">
                <table className="data-table">
                  <caption className="sr-only">등록된 평가 루브릭</caption>
                  <thead>
                    <tr>
                      <th scope="col">이름</th>
                      <th scope="col">기준</th>
                      <th scope="col">생성 시각</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rubrics.data.rubrics.map((rubric) => (
                      <tr key={rubric.id}>
                        <td>{rubric.name}</td>
                        <td className="mono truncate">{rubric.criteria_json || "-"}</td>
                        <td>{formatDateTime(rubric.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>
        ) : null}
      </TabPanel>

      <FormDialog
        open={experimentOpen}
        onOpenChange={setExperimentOpen}
        returnFocusRef={returnFocusRef}
        form={experimentForm}
        title="실험 만들기"
        description="실험은 테스트 케이스를 묶는 단위입니다."
        onSubmit={(values) => createExperiment.mutateAsync(values)}
      >
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
      >
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
        >
          {(control) => <Textarea {...control} rows={5} {...contractForm.register("schema_json")} />}
        </FormField>
        <Checkbox
          label="엄격 모드"
          description="형식을 위반하면 실패로 처리합니다."
          {...contractForm.register("strict")}
        />
      </FormDialog>

      <FormDialog
        open={rubricOpen}
        onOpenChange={setRubricOpen}
        returnFocusRef={returnFocusRef}
        form={rubricForm}
        title="평가 루브릭 추가"
        description="채점 기준을 JSON으로 저장합니다."
        onSubmit={(values) => createRubric.mutateAsync(values)}
      >
        <FormField label="이름" required error={rubricForm.formState.errors.name?.message}>
          {(control) => <Input {...control} {...rubricForm.register("name")} />}
        </FormField>
        <FormField
          label="기준(JSON)"
          error={rubricForm.formState.errors.criteria_json?.message}
          description='예: {"accuracy": 0.4, "completeness": 0.3}'
        >
          {(control) => <Textarea {...control} rows={5} {...rubricForm.register("criteria_json")} />}
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
      >
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
        <FormField label="평가 루브릭">
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
        <FormField label="System 프롬프트">
          {(control) => <Textarea {...control} rows={3} {...testCaseForm.register("system")} />}
        </FormField>
        <FormField label="User 프롬프트" required error={testCaseForm.formState.errors.user?.message}>
          {(control) => <Textarea {...control} rows={5} {...testCaseForm.register("user")} />}
        </FormField>
      </FormDialog>

      <ConfirmDialog
        open={removeCase !== undefined}
        onOpenChange={(open) => {
          if (!open) setRemoveCase(undefined);
        }}
        returnFocusRef={returnFocusRef}
        tone="danger"
        title="테스트 케이스 삭제"
        description={`${removeCase?.name ?? ""} 테스트 케이스와 실행 이력을 삭제합니다.`}
        confirmLabel="삭제"
        onConfirm={async () => {
          if (!removeCase) return;
          await deleteTestCase.mutateAsync(removeCase.id);
          setRemoveCase(undefined);
        }}
      />
    </div>
  );
}
