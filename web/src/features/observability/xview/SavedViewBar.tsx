import { useQuery } from "@tanstack/react-query";
import { Save, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { z } from "zod";

import { apiClient } from "@/shared/api/client";
import { withObservabilityPath } from "@/shared/api/domains/observability";
import type { SavedFilter } from "@/shared/api/domains/observability.schemas";
import { endpoints } from "@/shared/api/endpoints";
import { FormDialog } from "@/shared/components/form/FormDialog";
import { FormField } from "@/shared/components/form/FormField";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { CopyButton } from "@/shared/components/ui/CopyButton";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { Select } from "@/shared/components/ui/Select";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";

const nameSchema = z.object({ name: z.string().trim().min(1, "이름을 입력하세요.").max(80) });
type NameInput = z.input<typeof nameSchema>;
type NameOutput = z.output<typeof nameSchema>;

const savedViewsQueryKey = ["observability", "xview", "saved-filters"] as const;

interface SavedViewBarProps {
  /** Current filter values, already limited to the keys the server accepts. */
  currentParams: string;
  canWrite: boolean;
  onApply: (params: string, id: string) => void;
  selectedId: string;
  writeDeniedReason: string;
}

export function SavedViewBar({
  canWrite,
  currentParams,
  onApply,
  selectedId,
  writeDeniedReason,
}: SavedViewBarProps): React.JSX.Element {
  const [saveOpen, setSaveOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SavedFilter>();
  const saveFocusRef = useRef<HTMLElement | null>(null);
  const deleteFocusRef = useRef<HTMLElement | null>(null);

  const views = useQuery({
    queryKey: savedViewsQueryKey,
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.observability.savedFilters.list, {
        query: { view: "xview" },
        signal,
        routeId: "observability.xview.saved-filters",
      }),
    staleTime: 60_000,
  });

  const form = useZodForm<NameInput, NameOutput>(nameSchema, { name: "" });

  const create = useMutationFeedback<NameOutput, unknown>({
    mutate: (values) =>
      apiClient.request(endpoints.domains.observability.savedFilters.create, {
        body: { view: "xview", name: values.name, params: currentParams },
        routeId: "observability.xview.saved-filters.create",
      }),
    invalidates: [savedViewsQueryKey],
    successMessage: "저장된 뷰를 만들었습니다.",
    errorMessage: "저장된 뷰를 만들지 못했습니다.",
  });

  const update = useMutationFeedback<SavedFilter, unknown>({
    mutate: (view) =>
      apiClient.request(
        withObservabilityPath(endpoints.domains.observability.savedFilters.update, { id: view.id }),
        {
          body: { params: currentParams },
          routeId: "observability.xview.saved-filters.update",
        },
      ),
    invalidates: [savedViewsQueryKey],
    successMessage: "저장된 뷰를 현재 필터로 덮어썼습니다.",
    errorMessage: "저장된 뷰를 덮어쓰지 못했습니다.",
  });

  const remove = useMutationFeedback<SavedFilter, unknown>({
    mutate: (view) =>
      apiClient.request(
        withObservabilityPath(endpoints.domains.observability.savedFilters.remove, { id: view.id }),
        { routeId: "observability.xview.saved-filters.delete" },
      ),
    invalidates: [savedViewsQueryKey],
    successMessage: "저장된 뷰를 삭제했습니다.",
    errorMessage: "저장된 뷰를 삭제하지 못했습니다.",
  });

  const filters = views.data?.filters ?? [];
  const selected = filters.find((view) => view.id === selectedId);
  const shareUrl = typeof window === "undefined" ? "" : window.location.href;

  return (
    <div className="obs-inline-form" role="group" aria-label="저장된 뷰">
      <label>
        저장된 뷰
        <Select
          value={selectedId}
          onChange={(event) => {
            const view = filters.find((item) => item.id === event.target.value);
            onApply(view?.params ?? "", view?.id ?? "");
          }}
          options={[
            { value: "", label: "직접 설정" },
            ...filters.map((view) => ({ value: view.id, label: view.name })),
          ]}
        />
      </label>
      <Button
        onClick={(event) => {
          saveFocusRef.current = event.currentTarget;
          form.reset({ name: "" });
          setSaveOpen(true);
        }}
        disabled={!canWrite}
        title={canWrite ? undefined : writeDeniedReason}
      >
        <Save aria-hidden="true" /> 새로 저장
      </Button>
      <Button
        onClick={() => selected && update.mutate(selected)}
        disabled={!canWrite || !selected || update.isPending}
        title={canWrite ? undefined : writeDeniedReason}
      >
        덮어쓰기
      </Button>
      <Button
        variant="danger"
        onClick={(event) => {
          deleteFocusRef.current = event.currentTarget;
          setDeleteTarget(selected);
        }}
        disabled={!canWrite || !selected}
        title={canWrite ? undefined : writeDeniedReason}
      >
        <Trash2 aria-hidden="true" /> 삭제
      </Button>
      <CopyButton value={shareUrl} label="링크 복사" size="default" />
      {views.isError ? (
        <InlineNotice tone="warning" title="저장된 뷰를 불러오지 못했습니다.">
          필터는 그대로 사용할 수 있습니다.
        </InlineNotice>
      ) : null}

      <FormDialog
        open={saveOpen}
        onOpenChange={setSaveOpen}
        returnFocusRef={saveFocusRef}
        form={form}
        title="현재 필터를 저장"
        description="지금 적용된 XView 필터를 이름과 함께 저장합니다."
        submitLabel="저장"
        onSubmit={async (values) => {
          await create.mutateAsync(values);
        }}
      >
        <FormField label="뷰 이름" required error={form.formState.errors.name?.message}>
          {(control) => <Input {...control} {...form.register("name")} />}
        </FormField>
      </FormDialog>

      <ConfirmDialog
        open={deleteTarget !== undefined}
        onOpenChange={(next) => {
          if (!next) setDeleteTarget(undefined);
        }}
        returnFocusRef={deleteFocusRef}
        tone="danger"
        title="저장된 뷰 삭제"
        description={`"${deleteTarget?.name ?? ""}" 뷰를 삭제합니다. 되돌릴 수 없습니다.`}
        confirmLabel="삭제"
        onConfirm={async () => {
          if (!deleteTarget) return;
          await remove.mutateAsync(deleteTarget);
          onApply("", "");
        }}
      />
    </div>
  );
}
