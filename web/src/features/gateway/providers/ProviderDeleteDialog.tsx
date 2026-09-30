import { useId, useState, type RefObject } from "react";
import "@/features/gateway/providers/provider-review.css";

import { ProviderDraftBoundary } from "@/features/gateway/providers/ProviderDraftBoundary";
import type { ProviderCatalogRow } from "@/features/gateway/providers/provider-catalog";
import { isAppError } from "@/shared/api/error";
import { FormField } from "@/shared/components/form/FormField";
import { Button } from "@/shared/components/ui/Button";
import { Dialog } from "@/shared/components/ui/Dialog";
import { Input } from "@/shared/components/ui/Input";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { useDraftGuard } from "@/shared/unsaved/use-draft-guard";

interface Props {
  row: ProviderCatalogRow;
  onOpenChange: (open: boolean) => void;
  onDelete: (identifier: string) => Promise<unknown>;
  returnFocusRef: RefObject<HTMLElement | null>;
}

export function ProviderDeleteDialog(props: Props): React.JSX.Element {
  return (
    <ProviderDraftBoundary>
      <ProviderDeleteConfirmation {...props} />
    </ProviderDraftBoundary>
  );
}

function ProviderDeleteConfirmation({
  row: initialRow,
  onOpenChange,
  onDelete,
  returnFocusRef,
}: Props): React.JSX.Element {
  const [row] = useState(initialRow);
  const target = row.nameRedacted ? row.identity : row.provider.name;
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<{ message: string; requestId?: string }>();
  const formId = useId();
  const guard = useDraftGuard({
    dirty: false,
    onDiscard: () => {
      setConfirmation("");
      setError(undefined);
      onOpenChange(false);
    },
  });
  const confirm = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (confirmation !== target) return;
    setError(undefined);
    void guard.run(
      () => onDelete(target),
      (cause) =>
        setError({
          message: safeAppErrorMessage(cause, "공급자를 삭제하지 못했습니다."),
          requestId: isAppError(cause) ? cause.requestId : undefined,
        }),
    );
  };
  return (
    <Dialog
      open
      title="공급자 삭제"
      description="공급자 연결을 삭제합니다. 관련 호출이 실패할 수 있습니다."
      returnFocusRef={returnFocusRef}
      onOpenChange={(open) => {
        if (!open) guard.requestClose();
      }}
      footer={
        <>
          <Button variant="secondary" disabled={guard.pending} onClick={() => guard.requestClose()}>
            취소
          </Button>
          <Button
            variant="danger"
            type="submit"
            form={formId}
            disabled={guard.pending || confirmation !== target}
          >
            {guard.pending ? "삭제 중" : "삭제"}
          </Button>
        </>
      }
    >
      <form id={formId} className="form-grid" onSubmit={confirm}>
        <p>
          삭제 대상: <code className="provider-delete-target">{target}</code>
        </p>
        <p>
          참조 영향은 조회하지 않았습니다. 라우팅 규칙·모델·팀의 사용 여부와 대체 경로의 성공은 확인되지
          않았습니다.
        </p>
        <FormField
          label="삭제 대상 재입력"
          description={
            row.nameRedacted
              ? "이름이 비공개이므로 위의 전체 공급자 참조를 그대로 입력하세요."
              : "위의 공급자 이름을 대소문자와 공백까지 정확히 입력하세요."
          }
        >
          {(control) => (
            <Input
              {...control}
              autoComplete="off"
              spellCheck={false}
              value={confirmation}
              disabled={guard.pending}
              onChange={(event) => setConfirmation(event.target.value)}
            />
          )}
        </FormField>
        {error ? (
          <p role="alert" className="form-error">
            {error.message}
            {error.requestId ? <span className="request-id"> 요청 ID: {error.requestId}</span> : null}
          </p>
        ) : null}
      </form>
    </Dialog>
  );
}
