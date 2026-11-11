import { useRef, useState } from "react";
import { useAuth } from "@/app/auth/AuthProvider";
import {
  promptLabKeys,
  promptLabRouteId,
  usePromptContracts,
  usePromptExperimentDetail,
  usePromptExperiments,
  usePromptRubrics,
} from "@/features/gateway/prompt-lab/use-prompt-lab";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import type {
  PromptExperiment,
  PromptTestCase,
  PromptTestCaseRun,
} from "@/shared/api/domains/gateway.schemas";
import { useLabReview } from "./use-lab-review";
import { withPathParams } from "@/shared/api/endpoint-factory";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { useLabAccess, useLabMutation } from "./use-lab-mutation";
import { featureOwnedKey, type FeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";
import { projectRun, labExecutionModels, labError, assertLabStatus } from "./prompt-lab-model";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { useTabParam } from "@/shared/hooks/use-tab-param";
import {
  experimentSchema,
  contractSchema,
  rubricSchema,
  testCaseSchema,
  tabIds,
  type PromptLabTabId,
  type ExperimentInput,
  type ExperimentOutput,
  type ContractInput,
  type ContractOutput,
  type RubricInput,
  type RubricOutput,
  type TestCaseInput,
  type TestCaseOutput,
} from "./prompt-lab-form";
const lab = endpoints.domains.gateway.promptLab;
export function usePromptLabController(owner: FeatureReadOwner) {
  const auth = useAuth();
  const access = useLabAccess();
  const canWrite = access.allowed;
  const writeDeniedReason = access.reason;
  const [tab, setTab] = useTabParam<PromptLabTabId>(tabIds);
  const [params, updateParams] = useSearchState();
  const selectedExperiment = params.get("exp") ?? "";

  const experiments = usePromptExperiments(owner);
  const contracts = usePromptContracts(owner);
  const rubrics = usePromptRubrics(owner);
  const detail = usePromptExperimentDetail(owner, selectedExperiment);
  const review = useLabReview(owner);

  const [experimentOpen, setExperimentOpen] = useState(false);
  const [contractOpen, setContractOpen] = useState(false);
  const [rubricOpen, setRubricOpen] = useState(false);
  const [testCaseOpen, setTestCaseOpen] = useState(false);
  const [removeCase, setRemoveCase] = useState<PromptTestCase>();
  const [runCase, setRunCase] = useState<PromptTestCase>();
  const [historyCase, setHistoryCase] = useState<PromptTestCase>();
  const [lastRun, setLastRun] = useState<{ name: string; result: PromptTestCaseRun } | undefined>();
  const [archiveTarget, setArchiveTarget] = useState<PromptExperiment | undefined>();
  const [removeExperiment, setRemoveExperiment] = useState<PromptExperiment | undefined>();
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

  const createExperiment = useLabMutation(owner, {
    mutate: (values: ExperimentOutput) =>
      apiClient.request(lab.experiments.create, {
        body: {
          title: values.title,
          description: values.description || undefined,
          team: values.team || undefined,
        },
        routeId: promptLabRouteId,
        retryUnauthorized: false,
      }),
    invalidates: [featureOwnedKey(promptLabKeys.experiments, owner)],
    successMessage: "실험을 만들었습니다.",
    errorMessage: "실험을 만들지 못했습니다.",
  });

  const createContract = useLabMutation(owner, {
    mutate: (values: ContractOutput) =>
      apiClient.request(lab.contracts.create, {
        body: {
          name: values.name,
          type: values.type,
          schema_json: values.schema_json || undefined,
          strict: values.strict,
        },
        routeId: promptLabRouteId,
        retryUnauthorized: false,
      }),
    invalidates: [featureOwnedKey(promptLabKeys.contracts, owner)],
    successMessage: "출력 계약을 저장했습니다.",
    errorMessage: "출력 계약을 저장하지 못했습니다.",
  });

  const createRubric = useLabMutation(owner, {
    mutate: (values: RubricOutput) =>
      apiClient.request(lab.rubrics.create, {
        body: {
          name: values.name,
          criteria: values.criteria_json === "" ? undefined : (JSON.parse(values.criteria_json) as unknown),
        },
        routeId: promptLabRouteId,
        retryUnauthorized: false,
      }),
    invalidates: [featureOwnedKey(promptLabKeys.rubrics, owner)],
    successMessage: "평가 기준을 저장했습니다.",
    errorMessage: "평가 기준을 저장하지 못했습니다.",
  });

  const createTestCase = useLabMutation(owner, {
    prepare: () => review(detail.data?.experiment),
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
        retryUnauthorized: false,
      }),
    invalidates: [featureOwnedKey(promptLabKeys.experiment(selectedExperiment), owner)],
    successMessage: "테스트 케이스를 추가했습니다.",
    errorMessage: "테스트 케이스를 추가하지 못했습니다.",
  });

  const deleteTestCase = useLabMutation(owner, {
    validate: (result) => assertLabStatus(result, "deleted"),
    prepare: (target: PromptTestCase) => review(detail.data?.experiment, target),
    mutate: (target: PromptTestCase) =>
      apiClient.request(withPathParams(lab.testCases.remove, { id: target.id }), {
        routeId: promptLabRouteId,
        retryUnauthorized: false,
      }),
    invalidates: [featureOwnedKey(promptLabKeys.experiment(selectedExperiment), owner)],
    successMessage: "테스트 케이스를 삭제했습니다.",
    errorMessage: "테스트 케이스를 삭제하지 못했습니다.",
  });

  const runTestCase = useLabMutation<PromptTestCase, PromptTestCaseRun>(owner, {
    prepare: async (target) => {
      if (!labExecutionModels(target.models_json))
        throw labError("저장된 실행 모델을 확인해 주세요.", "prompt_lab_models");
      await review(detail.data?.experiment, target);
    },
    mutate: async ({ id, models_json }) => {
      const models = labExecutionModels(models_json);
      if (!models) throw labError("저장된 모델을 확인해 주세요.");
      return projectRun(
        await apiClient.request(withPathParams(lab.testCases.run, { id }), {
          // The saved prompt is not re-persisted on the run that this creates.
          body: { save_prompt: false },
          routeId: promptLabRouteId,
          retryUnauthorized: false,
        }),
        auth.credentialPrefixes,
        models,
      );
    },
    invalidates: [featureOwnedKey(promptLabKeys.experiment(selectedExperiment), owner)],
    successMessage: (result) =>
      result.best_model ? `실행을 마쳤습니다. 최고 점수 모델: ${result.best_model}` : "실행을 마쳤습니다.",
    errorMessage: "테스트 케이스를 실행하지 못했습니다.",
    onSuccess: (result, variables) => setLastRun({ name: variables.name, result }),
  });

  const updateExperimentStatus = useLabMutation<
    { original: PromptExperiment; status: "active" | "archived" },
    unknown
  >(owner, {
    validate: (result, { status }) => assertLabStatus(result, status),
    prepare: ({ original }) => review(original),
    mutate: ({ original, status }) =>
      apiClient.request(withPathParams(lab.experiments.updateStatus, { id: original.id }), {
        body: { status },
        routeId: promptLabRouteId,
        retryUnauthorized: false,
      }),
    invalidates: ({ original }) => [
      featureOwnedKey(promptLabKeys.experiments, owner),
      featureOwnedKey(promptLabKeys.experiment(original.id), owner),
    ],
    successMessage: (_result, variables) =>
      variables.status === "archived" ? "실험을 보관했습니다." : "실험을 다시 진행 중으로 바꿨습니다.",
    errorMessage: "실험 상태를 바꾸지 못했습니다.",
  });

  const deleteExperiment = useLabMutation<PromptExperiment, unknown>(owner, {
    validate: (result) => assertLabStatus(result, "deleted"),
    prepare: (target) => review(target),
    mutate: (target) =>
      apiClient.request(withPathParams(lab.experiments.remove, { id: target.id }), {
        routeId: promptLabRouteId,
        retryUnauthorized: false,
      }),
    invalidates: [featureOwnedKey(promptLabKeys.experiments, owner)],
    successMessage: "실험을 삭제했습니다.",
    errorMessage: "실험을 삭제하지 못했습니다.",
  });

  const openDialog = (
    trigger: React.RefObject<HTMLButtonElement | null>,
    setOpen: (open: boolean) => void,
  ): void => {
    returnFocusRef.current = trigger.current;
    setOpen(true);
  };

  return {
    owner,
    auth,
    canWrite,
    writeDeniedReason,
    tab,
    setTab,
    selectedExperiment,
    updateParams,
    experiments,
    contracts,
    rubrics,
    detail,
    experimentOpen,
    setExperimentOpen,
    contractOpen,
    setContractOpen,
    rubricOpen,
    setRubricOpen,
    testCaseOpen,
    setTestCaseOpen,
    removeCase,
    setRemoveCase,
    runCase,
    setRunCase,
    historyCase,
    setHistoryCase,
    lastRun,
    setLastRun,
    archiveTarget,
    setArchiveTarget,
    removeExperiment,
    setRemoveExperiment,
    returnFocusRef,
    newExperimentRef,
    newContractRef,
    newRubricRef,
    newTestCaseRef,
    experimentForm,
    contractForm,
    rubricForm,
    testCaseForm,
    createExperiment,
    createContract,
    createRubric,
    createTestCase,
    deleteTestCase,
    runTestCase,
    updateExperimentStatus,
    deleteExperiment,
    openDialog,
  };
}
export type PromptLabController = ReturnType<typeof usePromptLabController>;
