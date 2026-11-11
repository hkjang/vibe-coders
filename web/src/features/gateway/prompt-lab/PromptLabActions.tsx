import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import type { PromptLabController } from "./use-prompt-lab-controller";
import { LabRunReview } from "./LabRunReview";
import { labExecutionModels } from "./prompt-lab-model";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";

export function PromptLabActions({ lab }: { lab: PromptLabController }) {
  const {
    selectedExperiment,
    updateParams,
    removeCase,
    setRemoveCase,
    runCase,
    setRunCase,
    archiveTarget,
    setArchiveTarget,
    removeExperiment,
    setRemoveExperiment,
    returnFocusRef,
    deleteTestCase,
    runTestCase,
    updateExperimentStatus,
    deleteExperiment,
  } = lab;
  return (
    <>
      {[deleteTestCase, runTestCase, updateExperimentStatus, deleteExperiment].some(
        (action) => action.uncertain,
      ) ? (
        <InlineNotice tone="warning" title="이전 작업 결과 확인 필요">
          서버에서 이미 처리했을 수 있어 같은 작업을 다시 전송하지 않습니다. 저장 내용과 실행·감사 이력을 먼저
          확인하세요.
        </InlineNotice>
      ) : null}
      <ConfirmDialog
        key={`remove-case:${removeCase?.id ?? "closed"}`}
        scrollBody
        confirmDisabled={!lab.canWrite || deleteTestCase.uncertain}
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
          await deleteTestCase.mutateAsync(removeCase);
          setRemoveCase(undefined);
        }}
      >
        <ActionNotice lab={lab} uncertain={deleteTestCase.uncertain} />
      </ConfirmDialog>

      <ConfirmDialog
        key={`run-case:${runCase?.id ?? "closed"}`}
        scrollBody
        confirmDisabled={
          !lab.canWrite ||
          runTestCase.uncertain ||
          !labExecutionModels(runCase?.models_json) ||
          lab.detail.isFetching ||
          lab.detail.isError
        }
        open={runCase !== undefined}
        onOpenChange={(open) => {
          if (!open) setRunCase(undefined);
        }}
        returnFocusRef={returnFocusRef}
        title="테스트 케이스 실행"
        description={`${runCase?.name ?? ""} 테스트 케이스를 저장된 모델로 실행합니다.`}
        confirmLabel="실행"
        onConfirm={async () => {
          if (!runCase) return;
          await runTestCase.mutateAsync(runCase);
          setRunCase(undefined);
        }}
      >
        <LabRunReview target={runCase} />
        <ActionNotice lab={lab} uncertain={runTestCase.uncertain} />
      </ConfirmDialog>

      <ConfirmDialog
        key={`archive:${archiveTarget?.id ?? "closed"}`}
        scrollBody
        confirmDisabled={!lab.canWrite || updateExperimentStatus.uncertain}
        open={archiveTarget !== undefined}
        onOpenChange={(open) => {
          if (!open) setArchiveTarget(undefined);
        }}
        returnFocusRef={returnFocusRef}
        title={archiveTarget?.status === "archived" ? "실험 다시 진행" : "실험 보관"}
        description={`${archiveTarget?.title ?? ""} 실험을 ${archiveTarget?.status === "archived" ? "다시 진행 중으로" : "보관 상태로"} 바꿉니다.`}
        confirmLabel={archiveTarget?.status === "archived" ? "다시 진행" : "보관"}
        onConfirm={async () => {
          if (!archiveTarget) return;
          await updateExperimentStatus.mutateAsync({
            original: archiveTarget,
            status: archiveTarget.status === "archived" ? "active" : "archived",
          });
          setArchiveTarget(undefined);
        }}
      >
        <ActionNotice lab={lab} uncertain={updateExperimentStatus.uncertain} />
      </ConfirmDialog>

      <ConfirmDialog
        key={`remove-experiment:${removeExperiment?.id ?? "closed"}`}
        scrollBody
        confirmDisabled={!lab.canWrite || deleteExperiment.uncertain}
        open={removeExperiment !== undefined}
        onOpenChange={(open) => {
          if (!open) setRemoveExperiment(undefined);
        }}
        returnFocusRef={returnFocusRef}
        tone="danger"
        title="실험 삭제"
        description={`${removeExperiment?.title ?? ""} 실험과 그 안의 테스트 케이스를 삭제합니다.`}
        confirmLabel="삭제"
        onConfirm={async () => {
          if (!removeExperiment) return;
          await deleteExperiment.mutateAsync(removeExperiment);
          if (selectedExperiment === removeExperiment.id) updateParams({ exp: undefined });
          setRemoveExperiment(undefined);
        }}
      >
        <ActionNotice lab={lab} uncertain={deleteExperiment.uncertain} />
      </ConfirmDialog>
    </>
  );
}
function ActionNotice({ lab, uncertain }: { lab: PromptLabController; uncertain: boolean }) {
  return (
    <>
      {!lab.canWrite ? <InlineNotice tone="warning">{lab.writeDeniedReason}</InlineNotice> : null}
      {uncertain ? (
        <InlineNotice tone="warning" title="이전 작업 결과 확인 필요">
          이 창을 닫고 저장 내용과 실행·감사 이력을 확인하세요. 같은 작업은 다시 전송하지 않습니다.
        </InlineNotice>
      ) : null}
    </>
  );
}
