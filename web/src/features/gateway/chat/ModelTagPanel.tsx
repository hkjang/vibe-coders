import { useRef, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { z } from "zod";

import { safeModelLabel } from "@/features/gateway/chat/chat-console";
import { chatRouteId, useModelUsageTags } from "@/features/gateway/chat/use-chat-console";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { withGatewayPathParams } from "@/shared/api/domains/gateway";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Textarea } from "@/shared/components/ui/Textarea";
import { FormDialog } from "@/shared/components/form/FormDialog";
import { FormField } from "@/shared/components/form/FormField";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { formatDateTime } from "@/shared/utils/format";

const tagFormSchema = z.object({
  model: z.string().trim().min(1, "모델 이름을 입력하세요.").max(256),
  good_for: z.string().trim().max(512).default(""),
  avoid_for: z.string().trim().max(512).default(""),
  risk_note: z.string().trim().max(1000).default(""),
});

type TagFormInput = z.input<typeof tagFormSchema>;
type TagFormOutput = z.output<typeof tagFormSchema>;

const tagQueryKey = ["admin", "model-tags"];

interface ModelTagPanelProps {
  canWrite: boolean;
  writeDeniedReason: string;
}

export function ModelTagPanel({ canWrite, writeDeniedReason }: ModelTagPanelProps): React.JSX.Element {
  const tags = useModelUsageTags();
  const [formOpen, setFormOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<string | undefined>();
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const form = useZodForm<TagFormInput, TagFormOutput>(tagFormSchema, {
    model: "",
    good_for: "",
    avoid_for: "",
    risk_note: "",
  });

  const save = useMutationFeedback({
    mutate: (values: TagFormOutput) =>
      apiClient.request(endpoints.domains.gateway.models.tags.save, {
        body: values,
        routeId: chatRouteId,
      }),
    invalidates: [tagQueryKey],
    successMessage: "모델 용도 태그를 저장했습니다.",
    errorMessage: "모델 용도 태그를 저장하지 못했습니다.",
  });

  const remove = useMutationFeedback({
    mutate: (model: string) =>
      apiClient.request(withGatewayPathParams(endpoints.domains.gateway.models.tags.remove, { id: model }), {
        routeId: chatRouteId,
      }),
    invalidates: [tagQueryKey],
    successMessage: "모델 용도 태그를 삭제했습니다.",
    errorMessage: "모델 용도 태그를 삭제하지 못했습니다.",
  });

  const openCreate = (existing?: {
    model: string;
    good_for: string;
    avoid_for: string;
    risk_note: string;
  }): void => {
    returnFocusRef.current = createButtonRef.current;
    form.reset(
      existing ?? {
        model: "",
        good_for: "",
        avoid_for: "",
        risk_note: "",
      },
    );
    setFormOpen(true);
  };

  return (
    <div className="page-stack">
      <SectionCard
        title="모델 용도 태그"
        description="어떤 작업에 적합하고 어떤 작업은 피해야 하는지 모델별로 기록합니다. 사용자 화면과 라우팅 추천에 함께 노출됩니다."
        actions={
          <Button
            ref={createButtonRef}
            size="small"
            variant="primary"
            disabled={!canWrite}
            title={canWrite ? undefined : writeDeniedReason}
            onClick={() => openCreate()}
          >
            <Plus aria-hidden="true" /> 태그 추가
          </Button>
        }
      >
        {!canWrite ? (
          <InlineNotice tone="warning" title="쓰기 권한이 없습니다.">
            {writeDeniedReason}
          </InlineNotice>
        ) : null}
        {tags.isError ? (
          <InlineNotice tone="warning" title="모델 용도 태그를 불러오지 못했습니다.">
            {safeAppErrorMessage(tags.error, "권한 또는 네트워크 상태를 확인하세요.")}
            <Button size="small" variant="ghost" onClick={() => void tags.refetch()}>
              다시 시도
            </Button>
          </InlineNotice>
        ) : (tags.data?.tags.length ?? 0) === 0 ? (
          <EmptyState
            title="등록된 용도 태그가 없습니다."
            description="자주 쓰는 모델에 적합/부적합 작업을 기록하면 팀이 모델을 고를 때 참고합니다."
          />
        ) : (
          <div className="data-table-scroll" tabIndex={0} aria-label="모델 용도 태그 표 영역">
            <table className="data-table">
              <caption className="sr-only">모델별 용도 태그</caption>
              <thead>
                <tr>
                  <th scope="col">모델</th>
                  <th scope="col">적합</th>
                  <th scope="col">부적합</th>
                  <th scope="col">위험 메모</th>
                  <th scope="col">수정 시각</th>
                  <th scope="col">작업</th>
                </tr>
              </thead>
              <tbody>
                {(tags.data?.tags ?? []).map((tag) => (
                  <tr key={tag.model}>
                    <td>{safeModelLabel(tag.model)}</td>
                    <td>{tag.good_for || "-"}</td>
                    <td>{tag.avoid_for || "-"}</td>
                    <td className="truncate">{tag.risk_note || "-"}</td>
                    <td>{formatDateTime(tag.updated_at)}</td>
                    <td>
                      <div className="toolbar-start">
                        <Button
                          size="small"
                          variant="ghost"
                          disabled={!canWrite}
                          title={canWrite ? undefined : writeDeniedReason}
                          onClick={() =>
                            openCreate({
                              model: tag.model,
                              good_for: tag.good_for,
                              avoid_for: tag.avoid_for,
                              risk_note: tag.risk_note,
                            })
                          }
                        >
                          수정
                        </Button>
                        <Button
                          size="small"
                          variant="ghost"
                          disabled={!canWrite}
                          title={canWrite ? undefined : writeDeniedReason}
                          onClick={() => setRemoveTarget(tag.model)}
                        >
                          <Trash2 aria-hidden="true" /> 삭제
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <FormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        returnFocusRef={returnFocusRef}
        form={form}
        title="모델 용도 태그"
        description="쉼표로 구분한 작업 유형을 입력합니다. 같은 모델을 다시 저장하면 기존 값을 덮어씁니다."
        onSubmit={(values) => save.mutateAsync(values)}
      >
        <FormField label="모델" required error={form.formState.errors.model?.message}>
          {(control) => <Input {...control} {...form.register("model")} />}
        </FormField>
        <FormField label="적합한 작업" description="예: code_review, sql, summary">
          {(control) => <Input {...control} {...form.register("good_for")} />}
        </FormField>
        <FormField label="피해야 할 작업">
          {(control) => <Input {...control} {...form.register("avoid_for")} />}
        </FormField>
        <FormField label="위험 메모">
          {(control) => <Textarea {...control} rows={3} {...form.register("risk_note")} />}
        </FormField>
      </FormDialog>

      <ConfirmDialog
        open={removeTarget !== undefined}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(undefined);
        }}
        returnFocusRef={returnFocusRef}
        tone="danger"
        title="모델 용도 태그 삭제"
        description={`${safeModelLabel(removeTarget)}의 용도 태그를 삭제합니다. 사용자 화면에서 즉시 사라집니다.`}
        confirmLabel="삭제"
        onConfirm={async () => {
          if (removeTarget === undefined) return;
          await remove.mutateAsync(removeTarget);
          setRemoveTarget(undefined);
        }}
      />
    </div>
  );
}
