import { Bookmark, ChevronDown, Pencil, Save, Trash2 } from "lucide-react";
import { useId, useRef, useState } from "react";
import { useAuth } from "@/app/auth/AuthProvider";
import type { AppRequestsQuery } from "@/shared/api/schemas";
import type { SavedFilter } from "@/shared/api/domains/observability.schemas";
import { isAppError } from "@/shared/api/error";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Select } from "@/shared/components/ui/Select";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { useFeatureMutationAccess } from "@/shared/feature-access/use-feature-mutation-access";
import {
  assertFeatureRead,
  useFeatureReadOwner,
  type FeatureReadOwner,
} from "@/shared/hooks/use-feature-read-owner";
import { RequestCriteriaReview } from "./RequestCriteriaReview";
import { RequestFilterNameDialog, type FilterEditor } from "./RequestFilterNameDialog";
import {
  reviewCurrentRequestCriteria,
  reviewSavedRequestCriteria,
  visibleRequestFilters,
} from "./request-saved-filter";
import { useRequestSavedFilters } from "./use-request-saved-filters";
import "./request-saved-filters.css";

interface Props {
  query: AppRequestsQuery;
  onApply: (params: URLSearchParams) => void;
}

export function RequestSavedFilters(props: Props): React.JSX.Element {
  const owner = useFeatureReadOwner("observability.requests", "request-saved-filter-owner");
  if (!owner.readable || owner.denied)
    return (
      <InlineNotice
        tone="warning"
        actions={
          owner.denied ? (
            <Button variant="secondary" onClick={owner.restart}>
              공유 필터 권한 다시 확인
            </Button>
          ) : undefined
        }
      >
        공유 필터 조회 권한을 확인할 수 없습니다.
      </InlineNotice>
    );
  return <OwnedRequestSavedFilters key={owner.id} {...props} owner={owner} />;
}

function OwnedRequestSavedFilters({
  query,
  onApply,
  owner,
}: Props & { owner: FeatureReadOwner }): React.JSX.Element {
  const auth = useAuth();
  const access = useFeatureMutationAccess(
    ["observability.requests"],
    auth.user?.scopes.includes("admin:write") === true,
    "공유 필터 저장·이름 변경·삭제에는 관리자 쓰기 권한이 필요합니다. 조회와 적용은 사용할 수 있습니다.",
  );
  const [expanded, setExpanded] = useState(false);
  const [selectedId, setSelectedId] = useState("");
  const [editor, setEditor] = useState<FilterEditor>();
  const [deleting, setDeleting] = useState<SavedFilter>();
  const origin = useRef<HTMLElement | null>(null);
  const panelId = useId();
  const selectId = useId();
  const { filters, change } = useRequestSavedFilters(owner, expanded, access.assertCurrent);
  const visible = visibleRequestFilters(filters.data?.filters ?? [], auth.credentialPrefixes);
  const hiddenCount = (filters.data?.filters.length ?? 0) - visible.length;
  const selected = visible.find((filter) => filter.id === selectedId);
  const review = selected ? reviewSavedRequestCriteria(selected.params, auth.credentialPrefixes) : undefined;
  const current = reviewCurrentRequestCriteria(query, auth.credentialPrefixes);
  const unavailable = filters.isFetching || Boolean(filters.error);
  const blocked = !access.allowed || change.isPending;
  return (
    <section className="request-saved-filters" aria-label="요청 공유 필터">
      <div className="saved-request-toolbar">
        <Button
          variant="secondary"
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={() => setExpanded((value) => !value)}
        >
          <Bookmark aria-hidden="true" /> 공유 필터 <ChevronDown aria-hidden="true" />
        </Button>
        <p>자주 쓰는 조회 조건을 관리자와 공유합니다.</p>
        <Button
          variant="secondary"
          disabled={blocked || !current.criteria}
          title={access.reason ?? current.error}
          onClick={(event) => {
            if (blocked || !current.criteria) return;
            origin.current = event.currentTarget;
            setEditor({ name: "", criteria: current.criteria });
          }}
        >
          <Save aria-hidden="true" /> 현재 조건 저장
        </Button>
      </div>
      {expanded ? (
        <div id={panelId} className="saved-request-panel">
          {access.reason ? <InlineNotice>{access.reason}</InlineNotice> : null}
          {filters.isPending ? <p role="status">공유 필터를 불러오는 중입니다.</p> : null}
          {filters.error ? (
            <InlineNotice
              tone="danger"
              title="공유 필터를 불러오지 못했습니다."
              actions={
                <Button
                  variant="secondary"
                  disabled={filters.isFetching}
                  onClick={() => void filters.refetch()}
                >
                  다시 시도
                </Button>
              }
            >
              {safeAppErrorMessage(filters.error, "잠시 후 다시 시도하세요.")}
              {isAppError(filters.error) && filters.error.requestId ? (
                <p>요청 ID: {filters.error.requestId}</p>
              ) : null}
            </InlineNotice>
          ) : null}
          {!filters.isPending && !filters.error && visible.length === 0 ? (
            <p>
              아직 사용할 수 있는 공유 필터가 없습니다. 조회 조건을 적용한 후 ‘현재 조건 저장’을 선택하세요.
            </p>
          ) : null}
          {hiddenCount > 0 ? (
            <InlineNotice tone="warning">
              이름이나 식별자를 안전하게 표시할 수 없는 필터 {hiddenCount}개를 숨겼습니다. 기존 화면에서
              확인하세요.
            </InlineNotice>
          ) : null}
          {visible.length > 0 ? (
            <>
              <div className="saved-request-selection">
                <label htmlFor={selectId}>저장된 공유 필터</label>
                <Select
                  id={selectId}
                  value={selected?.id ?? ""}
                  disabled={unavailable || change.isPending}
                  onChange={(event) => setSelectedId(event.currentTarget.value)}
                  options={[
                    { value: "", label: "조건을 확인할 필터 선택" },
                    ...visible.map((item) => ({ value: item.id, label: item.name })),
                  ]}
                />
                <Button
                  variant="secondary"
                  disabled={!selected || blocked || unavailable}
                  title={access.reason}
                  onClick={(event) => {
                    if (selected) {
                      origin.current = event.currentTarget;
                      setEditor({ id: selected.id, name: selected.name });
                    }
                  }}
                >
                  <Pencil aria-hidden="true" /> 이름 변경
                </Button>
                <Button
                  variant="danger"
                  disabled={!selected || blocked || unavailable}
                  title={access.reason}
                  onClick={(event) => {
                    if (selected) {
                      origin.current = event.currentTarget;
                      setDeleting(selected);
                    }
                  }}
                >
                  <Trash2 aria-hidden="true" /> 삭제
                </Button>
              </div>
              {review?.error ? <InlineNotice tone="warning">{review.error}</InlineNotice> : null}
              {review?.criteria ? (
                <>
                  <RequestCriteriaReview criteria={review.criteria} />
                  <Button
                    disabled={unavailable || change.isPending}
                    onClick={() => {
                      if (!review.criteria || unavailable) return;
                      assertFeatureRead(owner);
                      onApply(new URLSearchParams(review.criteria.params));
                    }}
                  >
                    이 조건으로 조회
                  </Button>
                </>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
      {editor ? (
        <RequestFilterNameDialog
          editor={editor}
          prefixes={auth.credentialPrefixes}
          deniedReason={access.reason}
          returnFocusRef={origin}
          onClose={() => setEditor(undefined)}
          onSubmit={async (name) => {
            if (editor.id) await change.mutateAsync({ kind: "rename", id: editor.id, name });
            else if (editor.criteria)
              await change.mutateAsync({ kind: "create", name, params: editor.criteria.params });
          }}
        />
      ) : null}
      {deleting ? (
        <ConfirmDialog
          open
          title="공유 필터 삭제"
          description="이 필터는 모든 관리자의 공유 목록에서 삭제됩니다. 요청 기록과 현재 조회 조건은 유지됩니다."
          returnFocusRef={origin}
          onOpenChange={(open) => {
            if (!open) setDeleting(undefined);
          }}
          confirmLabel="공유 필터 삭제"
          confirmDisabled={blocked}
          tone="danger"
          onConfirm={async () => {
            await change.mutateAsync({ kind: "delete", id: deleting.id });
            setSelectedId("");
          }}
        >
          <p>
            <strong>{deleting.name}</strong> 필터를 삭제합니다.
          </p>
          {access.reason ? <InlineNotice tone="warning">{access.reason}</InlineNotice> : null}
        </ConfirmDialog>
      ) : null}
    </section>
  );
}
