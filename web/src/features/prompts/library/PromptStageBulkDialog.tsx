import { useEffect, useState, type RefObject } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useAuth } from "@/app/auth/AuthProvider";
import { apiClient } from "@/shared/api/client";
import { AppError, isAppError } from "@/shared/api/error";
import { stageBulkEndpoints } from "@/shared/api/domains/prompt-stage-bulk";
import type { StageQuery } from "@/shared/api/domains/prompt-stages";
import type {
  PromptStageBulkApply,
  PromptStageBulkReview,
  PromptStageWorkspaceItem,
} from "@/shared/api/generated";
import { FormDialog } from "@/shared/components/form/FormDialog";
import { FormField } from "@/shared/components/form/FormField";
import { Button } from "@/shared/components/ui/Button";
import { Checkbox } from "@/shared/components/ui/Checkbox";
import { Dialog } from "@/shared/components/ui/Dialog";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { DataTable } from "@/shared/data-table/DataTable";
import type { DataTableColumn } from "@/shared/data-table/columns";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { formatDateTime, formatNumber } from "@/shared/utils/format";
import { LibraryWriteNotice } from "./LibraryWriteNotice";
import { libraryError, libraryRouteId } from "./library-model";
import { useLibraryAccess, useLibraryBusy, useLibraryMutation } from "./use-library-mutation";
import { useLibraryQuery } from "./use-library-query";
import { stageReasonSchema } from "./stage-form";
import { readStageBulkReview } from "./stage-bulk-api";
import { stageBulkMessages as text } from "./stage-bulk-messages";
import { stageMessages } from "./stage-messages";

interface Props {
  window: StageQuery["window"];
  onClose: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}

export function PromptStageBulkDialog(props: Props) {
  const [nonce] = useState(() => crypto.randomUUID());
  const query = useLibraryQuery({
    key: ["prompts", "bulk-review", props.window, nonce],
    read: (prefixes, signal) => readStageBulkReview(props.window, prefixes, signal),
    enabled: false,
  });
  const { refetch } = query;
  // Review stays fixed while the operator checks it. Global refresh, focus and
  // reconnect cannot replace the plan or silently reset a dirty confirmation.
  useEffect(() => {
    void refetch();
  }, [refetch]);
  if (query.data) return <BulkForm {...props} review={query.data} />;
  return (
    <Dialog
      open
      title={text.title}
      description={text.scope}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
      returnFocusRef={props.returnFocusRef}
      footer={<Button onClick={props.onClose}>닫기</Button>}
    >
      {query.isError ? (
        <InlineNotice tone="danger" title={text.failed}>
          {isAppError(query.error) && query.error.code === "prompt_library_bulk_limit"
            ? text.limit
            : safeAppErrorMessage(query.error, text.failed)}
          <Button disabled={query.isFetching} onClick={() => void query.refetch()}>
            {text.retry}
          </Button>
        </InlineNotice>
      ) : (
        <p role="status">승격 대상과 관측 기준을 확인하고 있습니다.</p>
      )}
    </Dialog>
  );
}

const columns: readonly DataTableColumn<PromptStageWorkspaceItem>[] = [
  { id: "name", header: stageMessages.columns.name, size: 210, cell: ({ row }) => row.original.name },
  {
    id: "version",
    header: stageMessages.columns.version,
    size: 120,
    cell: ({ row }) => row.original.version,
  },
  {
    id: "before",
    header: text.before,
    size: 120,
    cell: ({ row }) => stageMessages.stages[row.original.stage],
  },
  {
    id: "after",
    header: text.after,
    size: 120,
    cell: ({ row }) =>
      row.original.eligible_stage ? stageMessages.stages[row.original.eligible_stage] : stageMessages.none,
  },
  {
    id: "calls",
    header: stageMessages.columns.calls,
    size: 100,
    cell: ({ row }) => formatNumber(row.original.calls),
  },
  {
    id: "errors",
    header: stageMessages.columns.errors,
    size: 110,
    cell: ({ row }) => formatNumber(row.original.errors),
  },
  {
    id: "evaluation",
    header: stageMessages.columns.evaluation,
    size: 140,
    cell: ({ row }) => formatNumber(row.original.evaluation_failures),
  },
];

function BulkForm({ review, onClose, returnFocusRef }: Props & { review: PromptStageBulkReview }) {
  const { credentialPrefixes } = useAuth();
  const access = useLibraryAccess();
  const busy = useLibraryBusy();
  const [page, setPage] = useState(0);
  const [conflict, setConflict] = useState(false);
  const deadline = Date.parse(review.expires_at);
  const [expired, setExpired] = useState(() => Date.now() >= deadline);
  useEffect(() => {
    const timer = window.setTimeout(() => setExpired(true), Math.max(0, deadline - Date.now()));
    return () => window.clearTimeout(timer);
  }, [deadline]);
  const count = review.items.length;
  const form = useForm({
    resolver: zodResolver(
      z.object({
        reason: stageReasonSchema(credentialPrefixes),
        count: z.string().refine((value) => value === String(count), text.countError),
        confirmed: z.boolean().refine(Boolean, stageMessages.confirmRequired),
      }),
    ),
    defaultValues: { reason: "", count: "", confirmed: false },
  });
  const mutation = useLibraryMutation({
    observation: "save",
    prepare: async () => {
      if (Date.now() >= deadline)
        throw new AppError(text.expired, { kind: "contract", code: "prompt_library_bulk_expired" });
    },
    mutate: (body: PromptStageBulkApply) =>
      apiClient.request(stageBulkEndpoints.apply, {
        query: { view: "promotion-review" },
        body,
        routeId: libraryRouteId,
        retryUnauthorized: false,
      }),
    validate: (receipt) => {
      if (receipt.count !== count || receipt.review_revision !== review.revision)
        throw libraryError("unknown");
    },
    invalidates: [["prompts", "stages"]],
    successMessage: `${formatNumber(count)}개 버전의 단계를 승격했습니다.`,
    errorMessage: text.failure,
  });
  const blocked =
    !access.allowed ||
    busy ||
    expired ||
    conflict ||
    mutation.uncertain ||
    !review.revision ||
    review.blocked_count > 0 ||
    count === 0;
  const errors = form.formState.errors;
  return (
    <FormDialog
      open
      title={text.title}
      description={text.scope}
      form={form}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      returnFocusRef={returnFocusRef}
      scrollBody
      wide
      scrollHint={text.scroll}
      submitLabel={`확인한 ${formatNumber(count)}개 승격`}
      submitDisabled={blocked}
      errorFormatter={(error) => {
        if (isAppError(error) && error.code === "prompt_library_bulk_expired") return text.expired;
        return isAppError(error) && error.status === 409
          ? text.conflict
          : safeAppErrorMessage(error, text.failure);
      }}
      onSubmit={async (values) => {
        try {
          await mutation.mutateAsync({
            window: review.window,
            since: review.since,
            until: review.until,
            revision: review.revision,
            reason: values.reason,
          });
        } catch (error) {
          if (isAppError(error) && error.status === 409) setConflict(true);
          throw error;
        }
      }}
    >
      <InlineNotice tone="info" title="고정된 검토 범위">
        <p>{text.freeze}</p>
        <p>
          {formatDateTime(review.since)} 이상 ~ {formatDateTime(review.until)} 미만
        </p>
        <p>
          검토 만료: <time dateTime={review.expires_at}>{formatDateTime(review.expires_at)}</time>
        </p>
      </InlineNotice>
      <LibraryWriteNotice uncertain={mutation.uncertain} />
      {expired ? (
        <InlineNotice tone="warning" title="검토 시간 만료">
          {text.expired}
        </InlineNotice>
      ) : null}
      {review.blocked_count > 0 ? (
        <InlineNotice tone="danger" title="일괄 변경 차단">
          {text.blocked}
        </InlineNotice>
      ) : null}
      <p role="status">
        관측 버전 {formatNumber(review.observed_count)}개 · 변경 대상 {formatNumber(count)}개 · 기준 미충족
        또는 승격 불가 {formatNumber(review.ignored_count)}개
      </p>
      <section className="min-w-0" aria-label={text.review}>
        <DataTable
          tableId="prompt-stage-bulk-review"
          caption={text.caption}
          lockedColumnIds={["name", "before", "after"]}
          columns={columns}
          data={review.items.slice(page * 25, (page + 1) * 25)}
          pageCount={Math.max(1, Math.ceil(count / 25))}
          pageIndex={page}
          onPageChange={setPage}
          emptyMessage={text.empty}
        />
      </section>
      <details>
        <summary>{stageMessages.criteria}</summary>
        <ul>
          {review.criteria.map((criterion) => (
            <li key={criterion.stage}>
              {stageMessages.stages[criterion.stage]}: 호출 {formatNumber(criterion.minimum_calls)}건 이상 ·
              오류율 {formatNumber(criterion.maximum_error_rate * 100)}% 이하 · 호출당 평가 실패{" "}
              {criterion.maximum_evaluation_failures_per_call}건 이하
            </li>
          ))}
        </ul>
        <p className="muted">{text.evaluationHelp}</p>
      </details>
      <p className="muted">{text.limit}</p>
      <FormField
        label={stageMessages.reason}
        description={stageMessages.reasonHelp}
        required
        error={errors.reason?.message}
      >
        {(props) => (
          <Input
            {...props}
            {...form.register("reason", { onChange: () => form.setValue("confirmed", false) })}
            disabled={!access.allowed}
            autoComplete="off"
          />
        )}
      </FormField>
      <FormField label={text.countLabel} description={text.countHelp} required error={errors.count?.message}>
        {(props) => (
          <Input
            {...props}
            {...form.register("count", { onChange: () => form.setValue("confirmed", false) })}
            disabled={!access.allowed}
            inputMode="numeric"
            autoComplete="off"
          />
        )}
      </FormField>
      <Checkbox
        label={text.confirm}
        {...form.register("confirmed")}
        disabled={!access.allowed}
        aria-invalid={Boolean(errors.confirmed)}
        aria-describedby={errors.confirmed ? "stage-bulk-confirm-error" : undefined}
      />
      {errors.confirmed ? (
        <p id="stage-bulk-confirm-error" className="field-error" role="alert">
          {errors.confirmed.message}
        </p>
      ) : null}
    </FormDialog>
  );
}
