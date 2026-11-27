import { FilterX, PencilLine, RefreshCw } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import type { WorkCorrectionResult, WorkPolicy } from "@/shared/api/domains/insights-classification";
import { workReviewStatuses } from "@/shared/api/domains/insights-classification";
import type { WorkRequest } from "@/shared/api/domains/insights-common";
import { FormField } from "@/shared/components/form/FormField";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { Dialog } from "@/shared/components/ui/Dialog";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { Textarea } from "@/shared/components/ui/Textarea";
import { DataTable } from "@/shared/data-table/DataTable";
import { RowSelectionCheckbox } from "@/shared/data-table/RowSelectionCheckbox";
import { createDataTableColumnHelper } from "@/shared/data-table/columns";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { formatDateTime, formatNumber } from "@/shared/utils/format";

import {
  actionName,
  assignableCategories,
  categoryPath,
  confidenceCeilings,
  formatConfidence,
  maxCorrectionIds,
  methodLabels,
  reviewFiltersFromParams,
  reviewLastPage,
  reviewPageSize,
  reviewQuery,
  statusLabels,
  statusTones,
} from "./classification-model";
import { CategorySelect } from "./fields";
import {
  classificationErrorMessage,
  useWorkReview,
  type useClassificationWrites,
} from "./use-classification";

const helper = createDataTableColumnHelper<WorkRequest>();
const emptyRows: WorkRequest[] = [];
const noSelection: ReadonlySet<string> = new Set();

interface ReviewTabProps {
  policy: WorkPolicy;
  writes: ReturnType<typeof useClassificationWrites>;
  canWrite: boolean;
  writeReason?: string;
}

export function ReviewTab({ policy, writes, canWrite, writeReason }: ReviewTabProps): React.JSX.Element {
  const [params, update] = useSearchState();
  const filters = reviewFiltersFromParams(params);
  const query = reviewQuery(filters);
  const queryKey = JSON.stringify(query);
  const review = useWorkReview(query);
  const data = review.data;
  const rows = data?.rows ?? emptyRows;
  // The count stops at 100,000 and no page past the server's largest offset is offered.
  const pageCount = Math.min(reviewLastPage, Math.max(1, Math.ceil((data?.count ?? 0) / reviewPageSize)));
  const categories = policy.config.categories;
  const filtered = Boolean(filters.status || filters.category || filters.maxConf !== undefined);

  // A selection belongs to one page of one filter; anything else starts empty.
  const [selection, setSelection] = useState<{ key: string; ids: ReadonlySet<string> }>({
    key: "",
    ids: noSelection,
  });
  const selectedIds = selection.key === queryKey ? selection.ids : noSelection;
  const selectedRows = useMemo(
    () => rows.filter((row) => selectedIds.has(row.request_id)),
    [rows, selectedIds],
  );
  const [correcting, setCorrecting] = useState(false);
  const [corrected, setCorrected] = useState<WorkCorrectionResult | undefined>(undefined);
  const correctRef = useRef<HTMLButtonElement>(null);

  const setFilter = (updates: Record<string, string | undefined>): void =>
    update({ ...updates, page: undefined });

  const columns = useMemo(() => {
    const all = rows.length > 0 && selectedRows.length === rows.length;
    const toggle = (id: string): void => {
      const next = new Set(selectedIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setSelection({ key: queryKey, ids: next });
    };
    return [
      helper.display({
        id: "select",
        meta: { label: "선택" },
        header: () => (
          <RowSelectionCheckbox
            label="현재 페이지 요청 전체 선택"
            checked={all}
            mixed={selectedRows.length > 0 && !all}
            disabled={rows.length === 0}
            onChange={() =>
              setSelection({
                key: queryKey,
                ids: all ? noSelection : new Set(rows.map((row) => row.request_id)),
              })
            }
          />
        ),
        cell: ({ row }) => (
          <RowSelectionCheckbox
            label={`${row.original.work_title || row.original.request_id} 선택`}
            checked={selectedIds.has(row.original.request_id)}
            disabled={false}
            onChange={() => toggle(row.original.request_id)}
          />
        ),
      }),
      // The title is what a reviewer decides by, so it comes first; related facts
      // share a cell so the queue reads without sideways scrolling on a desktop.
      helper.display({
        id: "title",
        header: "제목 · 태그",
        cell: ({ row }) => (
          <span className="wc-stack wc-title-cell">
            {row.original.work_title ? (
              <strong>{row.original.work_title}</strong>
            ) : (
              // Without access to raw prompts the server sends no title (it comes from the prompt).
              <strong className="wc-muted" title="작업 제목이 없어 업무 이름을 대신 표시합니다.">
                {row.original.category.name || "—"}
              </strong>
            )}
            {row.original.tags.length > 0 ? (
              <span className="wc-chips">
                {row.original.tags.map((tag) => (
                  <span key={tag} className="wc-chip">
                    {tag}
                  </span>
                ))}
              </span>
            ) : null}
          </span>
        ),
      }),
      helper.display({
        id: "category",
        header: "현재 분류 · 작업",
        cell: ({ row }) => (
          <span className="wc-stack">
            <span>
              {categoryPath(categories, row.original.category.id).join(" › ") || row.original.category.name}
            </span>
            <code className="wc-muted">{row.original.category.id}</code>
            <span className="wc-muted">작업: {actionName(policy.config, row.original.action_type)}</span>
          </span>
        ),
      }),
      helper.display({
        id: "confidence",
        header: "신뢰도 · 방식",
        cell: ({ row }) => (
          <span className="wc-stack">
            <span className="wc-nowrap">
              {formatConfidence(row.original.confidence)} ·{" "}
              {methodLabels[row.original.method] ?? row.original.method}
            </span>
            <span>
              <Badge tone={statusTones[row.original.status] ?? "muted"}>
                {statusLabels[row.original.status] ?? row.original.status}
              </Badge>
            </span>
          </span>
        ),
      }),
      helper.display({
        id: "origin",
        header: "팀 · 클라이언트 · 모델",
        cell: ({ row }) => (
          <span className="wc-stack">
            <span>{row.original.team || "팀 없음"}</span>
            <span className="wc-muted">{row.original.client || "클라이언트 미상"}</span>
            <span className="wc-muted">{row.original.model || "모델 미상"}</span>
          </span>
        ),
      }),
      helper.display({
        id: "created_at",
        header: "시각",
        cell: ({ row }) => <span className="wc-nowrap">{formatDateTime(row.original.created_at)}</span>,
      }),
    ];
  }, [rows, selectedRows, selectedIds, queryKey, categories, policy.config]);

  const summary = data?.summary;
  const tooMany = selectedRows.length > maxCorrectionIds;

  return (
    <>
      <StatGrid label="검토 대기열 요약">
        {workReviewStatuses.map((status) => (
          <StatCard
            key={status}
            label={statusLabels[status]}
            tone={status === "failed" && (summary?.failed ?? 0) > 0 ? "danger" : "default"}
            value={summary ? `${formatNumber(summary[status])}건` : "—"}
            hint={
              <button
                type="button"
                className="wc-link-button"
                aria-pressed={filters.status === status}
                onClick={() => setFilter({ status: filters.status === status ? undefined : status })}
              >
                {filters.status === status ? "필터 해제" : "이 상태만 보기"}
              </button>
            }
          />
        ))}
      </StatGrid>

      <SectionCard
        headingLevel={3}
        title="신규 카테고리 후보"
        description="분류 모델이 기존 카테고리에 맞는 것이 없다고 본 업무입니다. 자주 나오는 후보는 카테고리 탭에서 새 카테고리나 키워드로 반영하세요."
      >
        {summary && summary.new_category_hints.length > 0 ? (
          <ul className="wc-chips" aria-label="신규 카테고리 후보 목록">
            {summary.new_category_hints.map((hint) => (
              <li key={hint.hint} className="wc-chip">
                {hint.hint} <strong>{formatNumber(hint.count)}</strong>
              </li>
            ))}
          </ul>
        ) : (
          <p className="wc-muted">{summary ? "후보가 없습니다." : "불러오는 중…"}</p>
        )}
      </SectionCard>

      <SectionCard
        headingLevel={3}
        title="검토 대기열"
        description="신뢰도가 낮거나 분류하지 못한 요청입니다. 맞는 분류를 골라 보정하면 그 날짜의 통계가 다시 계산됩니다."
        actions={
          <>
            {filtered ? (
              <Button
                size="small"
                variant="ghost"
                onClick={() => setFilter({ status: undefined, category: undefined, max_conf: undefined })}
              >
                <FilterX aria-hidden="true" /> 필터 초기화
              </Button>
            ) : null}
            <Button size="small" onClick={() => void review.refetch()} disabled={review.isFetching}>
              <RefreshCw aria-hidden="true" /> 새로고침
            </Button>
          </>
        }
      >
        <div className="wc-filter-grid">
          <FormField label="상태">
            {(control) => (
              <Select
                {...control}
                value={filters.status ?? ""}
                onChange={(event) => setFilter({ status: event.target.value || undefined })}
              >
                <option value="">전체</option>
                {workReviewStatuses.map((status) => (
                  <option key={status} value={status}>
                    {statusLabels[status]}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
          <FormField label="카테고리">
            {(control) => (
              <CategorySelect
                {...control}
                categories={categories}
                value={filters.category ?? ""}
                emptyLabel="전체"
                onChange={(id) => setFilter({ category: id || undefined })}
              />
            )}
          </FormField>
          <FormField label="신뢰도 상한">
            {(control) => (
              <Select
                {...control}
                value={filters.maxConf === undefined ? "" : String(filters.maxConf)}
                onChange={(event) => setFilter({ max_conf: event.target.value || undefined })}
              >
                <option value="">전체</option>
                {filters.maxConf !== undefined &&
                !(confidenceCeilings as readonly number[]).includes(filters.maxConf) ? (
                  <option value={String(filters.maxConf)}>{filters.maxConf} 이하</option>
                ) : null}
                {confidenceCeilings.map((value) => (
                  <option key={value} value={String(value)}>
                    {value} 이하
                  </option>
                ))}
              </Select>
            )}
          </FormField>
        </div>

        {corrected ? (
          <InlineNotice
            tone="success"
            title={`${formatNumber(corrected.corrected)}건의 분류를 보정했습니다.`}
            actions={
              <Button size="small" variant="ghost" onClick={() => setCorrected(undefined)}>
                닫기
              </Button>
            }
          >
            {corrected.days_rebuilt.length > 0
              ? `집계를 다시 만든 날짜: ${corrected.days_rebuilt.join(", ")}`
              : "다시 만든 집계가 없습니다."}
          </InlineNotice>
        ) : null}

        <div className="wc-selection-bar">
          <span role="status">
            전체 {formatNumber(data?.count ?? 0)}건 · 이 페이지 {formatNumber(rows.length)}건 중{" "}
            {formatNumber(selectedRows.length)}건 선택
          </span>
          <Button
            size="small"
            variant="ghost"
            disabled={selectedRows.length === 0}
            onClick={() => setSelection({ key: queryKey, ids: noSelection })}
          >
            선택 해제
          </Button>
          <Button
            ref={correctRef}
            size="small"
            variant="primary"
            disabled={!canWrite || selectedRows.length === 0 || tooMany}
            title={
              canWrite
                ? tooMany
                  ? `한 번에 ${maxCorrectionIds}건까지 보정할 수 있습니다.`
                  : selectedRows.length === 0
                    ? "보정할 요청을 먼저 선택하세요."
                    : undefined
                : writeReason
            }
            onClick={() => setCorrecting(true)}
          >
            <PencilLine aria-hidden="true" /> 분류 보정
          </Button>
        </div>

        {review.isError && !data ? (
          <InlineNotice
            tone="danger"
            title="검토 대기열을 불러오지 못했습니다."
            actions={<Button onClick={() => void review.refetch()}>다시 시도</Button>}
          >
            {classificationErrorMessage(review.error, "잠시 후 다시 시도하세요.")}
          </InlineNotice>
        ) : !review.isPending && rows.length === 0 && !filtered ? (
          <EmptyState
            title="검토할 요청이 없습니다."
            description="신뢰도가 낮거나 분류하지 못한 요청이 생기면 여기에 모입니다."
          />
        ) : (
          <div className="wc-review-table">
            <DataTable
              caption="검토 대기열"
              columns={columns}
              data={rows}
              getRowId={(row) => row.request_id}
              loading={review.isPending}
              emptyMessage="조건에 맞는 요청이 없습니다. 필터를 조정해 보세요."
              pageCount={pageCount}
              pageIndex={Math.min(filters.page - 1, pageCount - 1)}
              onPageChange={(pageIndex) =>
                update({ page: pageIndex === 0 ? undefined : pageIndex + 1 }, { replace: false })
              }
            />
          </div>
        )}
      </SectionCard>

      {correcting ? (
        <CorrectionDialog
          rows={selectedRows}
          policy={policy}
          returnFocusRef={correctRef}
          onClose={() => setCorrecting(false)}
          onSubmit={async (input) => {
            const result = await writes.correct.mutateAsync({
              requestIds: selectedRows.map((row) => row.request_id),
              ...input,
            });
            setCorrected(result);
            setSelection({ key: queryKey, ids: noSelection });
            setCorrecting(false);
          }}
        />
      ) : null}
    </>
  );
}

function CorrectionDialog({
  rows,
  policy,
  returnFocusRef,
  onClose,
  onSubmit,
}: {
  rows: readonly WorkRequest[];
  policy: WorkPolicy;
  returnFocusRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  onSubmit: (input: { categoryId: string; actionType: string; reason: string }) => Promise<void>;
}): React.JSX.Element {
  const [search, setSearch] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [actionType, setActionType] = useState("");
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const options = assignableCategories(policy.config.categories, search);
  const chosen = categoryId ? categoryPath(policy.config.categories, categoryId).join(" › ") : "";
  const ready = categoryId !== "" && reason.trim() !== "" && !pending;

  const submit = async (): Promise<void> => {
    if (!ready) return;
    setPending(true);
    setError(undefined);
    try {
      await onSubmit({ categoryId, actionType, reason: reason.trim() });
    } catch (cause) {
      setError(classificationErrorMessage(cause, "분류를 보정하지 못했습니다."));
      setPending(false);
    }
  };

  return (
    <Dialog
      open
      scrollBody
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
      returnFocusRef={returnFocusRef}
      title="분류 보정"
      description={`선택한 요청 ${rows.length}건의 분류를 고릅니다.`}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            취소
          </Button>
          <Button variant="primary" disabled={!ready} onClick={() => void submit()}>
            {pending ? "보정 중" : `${rows.length}건 보정`}
          </Button>
        </>
      }
    >
      <div className="wc-dialog">
        <InlineNotice tone="info">
          보정한 내용은 검증 데이터로 쌓여 정확도 확인과 신뢰도 보정에 쓰입니다. 정책(규칙·프롬프트)을 직접
          바꾸지는 않으므로, 같은 요청이 계속 틀리면 카테고리 탭에서 규칙을 고치세요. 보정한 요청은 재분류해도
          유지됩니다.
        </InlineNotice>
        {policy.dirty ? (
          <p className="wc-muted wc-note">
            아직 배포하지 않은 카테고리는 서버가 받아들이지 않을 수 있습니다. 새 카테고리는 배포한 뒤 쓰세요.
          </p>
        ) : null}
        <FormField label="카테고리 찾기">
          {(control) => (
            <Input
              {...control}
              type="search"
              value={search}
              placeholder="이름이나 ID"
              autoComplete="off"
              onChange={(event) => setSearch(event.target.value)}
            />
          )}
        </FormField>
        <fieldset className="wc-picker">
          <legend>
            바꿀 카테고리
            <span className="field-required" aria-hidden="true">
              *
            </span>
          </legend>
          {options.length === 0 ? (
            <p className="wc-muted">조건에 맞는 카테고리가 없습니다.</p>
          ) : (
            <div className="wc-picker-list">
              {options.map((option) => (
                <label key={option.id} className="wc-picker-option" data-level={option.level}>
                  <input
                    type="radio"
                    name="wc-correct-category"
                    value={option.id}
                    checked={categoryId === option.id}
                    onChange={() => setCategoryId(option.id)}
                  />
                  <span>
                    {option.path} <code className="wc-muted">{option.id}</code>
                  </span>
                </label>
              ))}
            </div>
          )}
        </fieldset>
        {chosen ? (
          <p className="wc-note" role="status">
            선택: <strong>{chosen}</strong>
          </p>
        ) : null}
        <FormField label="작업 유형" description="비워 두면 작업 유형은 바꾸지 않습니다.">
          {(control) => (
            <Select {...control} value={actionType} onChange={(event) => setActionType(event.target.value)}>
              <option value="">바꾸지 않음</option>
              {policy.config.action_types.map((action) => (
                <option key={action.id} value={action.id}>
                  {action.name || action.id}
                </option>
              ))}
            </Select>
          )}
        </FormField>
        <FormField label="보정 사유" required description="감사 이력과 보정 이력에 남습니다.">
          {(control) => (
            <Textarea
              {...control}
              rows={2}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          )}
        </FormField>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
