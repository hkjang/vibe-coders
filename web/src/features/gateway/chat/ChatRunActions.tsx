import { useRef, useState } from "react";
import { Download, GitCompare, MessageSquarePlus, Star, Trophy } from "lucide-react";
import { z } from "zod";

import { safeModelLabel } from "@/features/gateway/chat/chat-console";
import {
  downloadMultiRunExport,
  multiRunExportFormatLabels,
  multiRunExportFormats,
  type MultiRunExportFormat,
} from "@/features/gateway/chat/multi-run-export";
import { chatRouteId } from "@/features/gateway/chat/use-chat-console";
import { apiClient } from "@/shared/api/client";
import type { MultiRunDiff } from "@/shared/api/domains/gateway.schemas";
import { withPathParams } from "@/shared/api/endpoint-factory";
import { endpoints } from "@/shared/api/endpoints";
import { isAppError } from "@/shared/api/error";
import { FormDialog } from "@/shared/components/form/FormDialog";
import { FormField } from "@/shared/components/form/FormField";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { Select } from "@/shared/components/ui/Select";
import { Textarea } from "@/shared/components/ui/Textarea";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { formatNumber } from "@/shared/utils/format";

const chat = endpoints.domains.gateway.chat;

const ratings = ["5", "4", "3", "2", "1", "0"] as const;

const feedbackSchema = z.object({
  model: z.string().trim().min(1, "모델을 선택하세요."),
  rating: z.enum(ratings),
  label: z.string().trim().max(120).default(""),
  comment: z.string().trim().max(2000).default(""),
});
type FeedbackInput = z.input<typeof feedbackSchema>;
type FeedbackValues = z.output<typeof feedbackSchema>;

const promoteSchema = z.object({
  model: z.string().trim().min(1, "모델을 선택하세요."),
  task_type: z.string().trim().max(120).default(""),
  reason: z.string().trim().min(1, "승격 사유를 입력하세요.").max(1000),
});
type PromoteInput = z.input<typeof promoteSchema>;
type PromoteValues = z.output<typeof promoteSchema>;

const goldenSchema = z
  .object({
    selected_model: z.string().trim().min(1, "모델을 선택하세요."),
    workflow_id: z.string().trim().max(120).default(""),
    workflow_name: z.string().trim().max(200).default(""),
    step_name: z.string().trim().max(200).default(""),
    task_type: z.string().trim().max(120).default(""),
    expected: z.string().trim().max(2000).default(""),
  })
  .refine((values) => values.workflow_id !== "" || values.workflow_name !== "", {
    message: "워크플로 이름 또는 기존 워크플로 ID 중 하나는 있어야 합니다.",
    path: ["workflow_name"],
  });
type GoldenInput = z.input<typeof goldenSchema>;
type GoldenValues = z.output<typeof goldenSchema>;

interface ChatRunActionsProps {
  runId: string;
  models: readonly string[];
  canWrite: boolean;
  writeDeniedReason: string;
  /** Kept in screen state; sent only when the run itself stored no prompt. */
  prompt: string;
}

/**
 * Per-run operations of the multi-model comparison: human feedback, promotion to a
 * routing-rule draft, saving a Golden workflow step, a block-level answer diff, and
 * the server-rendered export.
 */
export function ChatRunActions({
  canWrite,
  models,
  prompt,
  runId,
  writeDeniedReason,
}: ChatRunActionsProps): React.JSX.Element {
  const firstModel = models[0] ?? "";
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [promoteOpen, setPromoteOpen] = useState(false);
  const [goldenOpen, setGoldenOpen] = useState(false);
  const [format, setFormat] = useState<MultiRunExportFormat>("md");
  const [diff, setDiff] = useState<MultiRunDiff | undefined>();
  const [pending, setPending] = useState<"" | "diff" | "export">("");
  const [error, setError] = useState<{ message: string; requestId?: string } | undefined>();
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const feedbackTrigger = useRef<HTMLButtonElement>(null);
  const promoteTrigger = useRef<HTMLButtonElement>(null);
  const goldenTrigger = useRef<HTMLButtonElement>(null);

  const feedbackForm = useZodForm<FeedbackInput, FeedbackValues>(feedbackSchema, {
    model: firstModel,
    rating: "4",
    label: "",
    comment: "",
  });
  const promoteForm = useZodForm<PromoteInput, PromoteValues>(promoteSchema, {
    model: firstModel,
    task_type: "",
    reason: "",
  });
  const goldenForm = useZodForm<GoldenInput, GoldenValues>(goldenSchema, {
    selected_model: firstModel,
    workflow_id: "",
    workflow_name: "",
    step_name: "",
    task_type: "",
    expected: "",
  });

  const sendFeedback = useMutationFeedback<FeedbackValues, unknown>({
    mutate: (values) =>
      apiClient.request(withPathParams(chat.multiRunFeedback, { id: runId }), {
        body: {
          model: values.model,
          rating: Number(values.rating),
          label: values.label || undefined,
          comment: values.comment || undefined,
        },
        routeId: chatRouteId,
      }),
    successMessage: "평가를 기록했습니다.",
    errorMessage: "평가를 기록하지 못했습니다.",
  });

  const promote = useMutationFeedback<PromoteValues, unknown>({
    mutate: (values) =>
      apiClient.request(withPathParams(chat.multiRunPromote, { id: runId }), {
        body: {
          model: values.model,
          task_type: values.task_type || undefined,
          reason: values.reason,
        },
        routeId: chatRouteId,
      }),
    successMessage: "라우팅 후보(초안)로 저장했습니다. 검토 전에는 라우팅에 적용되지 않습니다.",
    errorMessage: "라우팅 후보로 승격하지 못했습니다.",
  });

  const saveGolden = useMutationFeedback<GoldenValues, unknown>({
    mutate: (values) =>
      apiClient.request(withPathParams(chat.multiRunGolden, { id: runId }), {
        body: {
          selected_model: values.selected_model,
          workflow_id: values.workflow_id || undefined,
          workflow_name: values.workflow_name || undefined,
          step_name: values.step_name || undefined,
          task_type: values.task_type || undefined,
          expected: values.expected || undefined,
          // The comparison runs with save_prompt off, so the server has no prompt of
          // its own; it is passed through here and not stored by the console.
          prompt: prompt.trim() || undefined,
        },
        routeId: chatRouteId,
      }),
    successMessage: "Golden 워크플로 단계로 저장했습니다.",
    errorMessage: "Golden 답변으로 저장하지 못했습니다.",
  });

  const runDiff = async (): Promise<void> => {
    setError(undefined);
    setPending("diff");
    try {
      setDiff(
        await apiClient.request(withPathParams(chat.multiRunDiff, { id: runId }), {
          routeId: chatRouteId,
        }),
      );
    } catch (cause) {
      setError({
        message: safeAppErrorMessage(cause, "답변을 비교하지 못했습니다."),
        requestId: isAppError(cause) ? cause.requestId : undefined,
      });
    } finally {
      setPending("");
    }
  };

  const runExport = async (): Promise<void> => {
    setError(undefined);
    setPending("export");
    try {
      await downloadMultiRunExport(runId, format);
    } catch (cause) {
      setError({
        message: safeAppErrorMessage(cause, "실행 결과를 내보내지 못했습니다."),
        requestId: isAppError(cause) ? cause.requestId : undefined,
      });
    } finally {
      setPending("");
    }
  };

  const modelOptions = models.map((model) => ({ value: model, label: safeModelLabel(model) }));
  const openForm = (
    trigger: React.RefObject<HTMLButtonElement | null>,
    setOpen: (open: boolean) => void,
  ): void => {
    returnFocusRef.current = trigger.current;
    setOpen(true);
  };

  return (
    <div className="gateway-run-actions">
      <div className="toolbar">
        <div className="toolbar-start">
          <Button
            ref={feedbackTrigger}
            size="small"
            variant="secondary"
            disabled={!canWrite || models.length === 0}
            title={canWrite ? undefined : writeDeniedReason}
            onClick={() => {
              feedbackForm.reset({ model: firstModel, rating: "4", label: "", comment: "" });
              openForm(feedbackTrigger, setFeedbackOpen);
            }}
          >
            <MessageSquarePlus aria-hidden="true" /> 평가 남기기
          </Button>
          <Button
            ref={promoteTrigger}
            size="small"
            variant="secondary"
            disabled={!canWrite || models.length === 0}
            title={canWrite ? undefined : writeDeniedReason}
            onClick={() => {
              promoteForm.reset({ model: firstModel, task_type: "", reason: "" });
              openForm(promoteTrigger, setPromoteOpen);
            }}
          >
            <Trophy aria-hidden="true" /> 라우팅 후보로 승격
          </Button>
          <Button
            ref={goldenTrigger}
            size="small"
            variant="secondary"
            disabled={!canWrite || models.length === 0}
            title={canWrite ? undefined : writeDeniedReason}
            onClick={() => {
              goldenForm.reset({
                selected_model: firstModel,
                workflow_id: "",
                workflow_name: "",
                step_name: "",
                task_type: "",
                expected: "",
              });
              openForm(goldenTrigger, setGoldenOpen);
            }}
          >
            <Star aria-hidden="true" /> Golden 답변으로 저장
          </Button>
          <Button size="small" variant="secondary" disabled={pending !== ""} onClick={() => void runDiff()}>
            <GitCompare aria-hidden="true" /> {pending === "diff" ? "비교 중" : "답변 비교"}
          </Button>
        </div>
        <div className="toolbar-end">
          <FormField label="내보내기 형식" id={`export-format-${runId}`}>
            {(control) => (
              <Select
                {...control}
                value={format}
                onChange={(event) => setFormat(event.target.value as MultiRunExportFormat)}
                options={multiRunExportFormats.map((value) => ({
                  value,
                  label: multiRunExportFormatLabels[value],
                }))}
              />
            )}
          </FormField>
          <Button size="small" variant="secondary" disabled={pending !== ""} onClick={() => void runExport()}>
            <Download aria-hidden="true" /> {pending === "export" ? "내보내는 중" : "서버에서 내보내기"}
          </Button>
        </div>
      </div>

      {error ? (
        <p className="form-error" role="alert">
          {error.message}
          {error.requestId ? <span className="request-id"> 요청 ID: {error.requestId}</span> : null}
        </p>
      ) : null}

      {diff ? <RunDiffView diff={diff} /> : null}

      <FormDialog
        open={feedbackOpen}
        onOpenChange={setFeedbackOpen}
        returnFocusRef={returnFocusRef}
        form={feedbackForm}
        title="모델 평가 남기기"
        description="사람이 매긴 평점은 리더보드와 학습 신호로 쓰입니다."
        onSubmit={(values) => sendFeedback.mutateAsync(values)}
      >
        <FormField label="모델" required error={feedbackForm.formState.errors.model?.message}>
          {(control) => <Select {...control} {...feedbackForm.register("model")} options={modelOptions} />}
        </FormField>
        <FormField label="평점" required description="0(최하)에서 5(최고)까지 매깁니다.">
          {(control) => (
            <Select
              {...control}
              {...feedbackForm.register("rating")}
              options={ratings.map((value) => ({ value, label: `${value}점` }))}
            />
          )}
        </FormField>
        <FormField label="라벨" description="예: best, wrong_format">
          {(control) => <Input {...control} {...feedbackForm.register("label")} />}
        </FormField>
        <FormField label="의견">
          {(control) => <Textarea {...control} rows={3} {...feedbackForm.register("comment")} />}
        </FormField>
      </FormDialog>

      <FormDialog
        open={promoteOpen}
        onOpenChange={setPromoteOpen}
        returnFocusRef={returnFocusRef}
        form={promoteForm}
        title="라우팅 후보로 승격"
        description="선택한 모델을 라우팅 규칙 초안으로 저장합니다. 사람이 검토하기 전에는 라우팅에 적용되지 않습니다."
        submitLabel="초안으로 저장"
        onSubmit={(values) => promote.mutateAsync(values)}
      >
        <FormField label="모델" required error={promoteForm.formState.errors.model?.message}>
          {(control) => <Select {...control} {...promoteForm.register("model")} options={modelOptions} />}
        </FormField>
        <FormField label="작업 유형" description="예: sql, code_review, summary">
          {(control) => <Input {...control} {...promoteForm.register("task_type")} />}
        </FormField>
        <FormField label="사유" required error={promoteForm.formState.errors.reason?.message}>
          {(control) => <Textarea {...control} rows={3} {...promoteForm.register("reason")} />}
        </FormField>
      </FormDialog>

      <FormDialog
        open={goldenOpen}
        onOpenChange={setGoldenOpen}
        returnFocusRef={returnFocusRef}
        form={goldenForm}
        title="Golden 답변으로 저장"
        description="선택한 모델의 결과를 Golden 워크플로 단계로 저장해 모델 교체 회귀 검사에 씁니다."
        onSubmit={(values) => saveGolden.mutateAsync(values)}
      >
        <FormField label="모델" required error={goldenForm.formState.errors.selected_model?.message}>
          {(control) => (
            <Select {...control} {...goldenForm.register("selected_model")} options={modelOptions} />
          )}
        </FormField>
        <FormField
          label="워크플로 이름"
          description="새 워크플로를 만들 때 입력합니다."
          error={goldenForm.formState.errors.workflow_name?.message}
        >
          {(control) => <Input {...control} {...goldenForm.register("workflow_name")} />}
        </FormField>
        <FormField label="기존 워크플로 ID" description="기존 워크플로에 단계를 덧붙일 때 입력합니다.">
          {(control) => <Input {...control} {...goldenForm.register("workflow_id")} />}
        </FormField>
        <FormField label="단계 이름" description="비우면 모델 이름으로 만듭니다.">
          {(control) => <Input {...control} {...goldenForm.register("step_name")} />}
        </FormField>
        <FormField label="작업 유형">
          {(control) => <Input {...control} {...goldenForm.register("task_type")} />}
        </FormField>
        <FormField label="기대 문구" description="회귀 검사에서 답변에 있어야 하는 표시입니다.">
          {(control) => <Textarea {...control} rows={2} {...goldenForm.register("expected")} />}
        </FormField>
      </FormDialog>
    </div>
  );
}

/** Block-level comparison of the stored answers; previews stay on this screen only. */
function RunDiffView({ diff }: { diff: MultiRunDiff }): React.JSX.Element {
  return (
    <div className="gateway-run-diff">
      <InlineNotice tone="info" title="답변 비교">
        {`응답한 모델 ${formatNumber(diff.answered_models ?? 0)}개 · 공통 블록 ${formatNumber(diff.common_blocks.length)}개`}
        {diff.note ? ` · ${diff.note}` : ""}
      </InlineNotice>
      <div className="data-table-scroll" tabIndex={0} aria-label="모델별 답변 비교 표 영역">
        <table className="data-table">
          <caption className="sr-only">모델별 공통·누락·고유 블록 수</caption>
          <thead>
            <tr>
              <th scope="col">모델</th>
              <th scope="col">블록</th>
              <th scope="col">누락</th>
              <th scope="col">고유</th>
              <th scope="col">형식</th>
            </tr>
          </thead>
          <tbody>
            {diff.per_model.map((row, index) => (
              <tr key={`${row.model ?? "model"}-${index}`}>
                <td className="mono">{safeModelLabel(row.model)}</td>
                <td className="cell-number">
                  {row.available ? formatNumber(row.block_count ?? 0) : "응답 없음"}
                </td>
                <td className="cell-number">{formatNumber(row.missing?.length ?? 0)}</td>
                <td className="cell-number">{formatNumber(row.extra?.length ?? 0)}</td>
                <td>
                  {row.stats?.has_table ? "표 포함" : "표 없음"}
                  {row.stats?.has_code ? " · 코드 포함" : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {diff.models.map((model, index) => (
        <details className="gateway-diff-model" key={`${model.model ?? "model"}-${index}`}>
          <summary>{`${safeModelLabel(model.model)} 블록 ${formatNumber(model.blocks?.length ?? 0)}개`}</summary>
          <ul className="gateway-list">
            {(model.blocks ?? []).map((block, blockIndex) => (
              <li key={`${block.key ?? blockIndex}`}>
                <strong>{block.type ?? "블록"}</strong>
                <span className="truncate">{block.preview ?? ""}</span>
              </li>
            ))}
          </ul>
        </details>
      ))}
    </div>
  );
}
