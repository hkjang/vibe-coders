import { useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { isAppError } from "@/shared/api/error";
import { PolicyImportProblem } from "@/shared/api/domains/policy-import-json";
import { Button } from "@/shared/components/ui/Button";
import { Checkbox } from "@/shared/components/ui/Checkbox";
import { Dialog } from "@/shared/components/ui/Dialog";
import { Input } from "@/shared/components/ui/Input";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { useUnsavedChanges } from "@/shared/unsaved/context";
import { UnsavedChangesProvider } from "@/shared/unsaved/UnsavedChangesProvider";
import { protectedJson } from "./policy-editor-security";
import type { PolicyImportAccess } from "./policy-import-access";
import { importDisplay, importImpacts } from "./policy-import-state";
import { usePolicyImportOperation } from "./policy-import-operation";
import { PolicyImportReview } from "./PolicyImportReview";
import "./policy-import.css";

interface Props {
  access: PolicyImportAccess;
  close: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}
function ImportDialog({ access, close, returnFocusRef }: Props) {
  const operation = usePolicyImportOperation(access, close);
  const { review, selected } = operation;
  const [confirmation, setConfirmation] = useState({
    review,
    text: "",
    activation: false,
    removal: false,
    protected: false,
  });
  if (confirmation.review !== review)
    setConfirmation({ review, text: "", activation: false, removal: false, protected: false });
  const [backupConfirmed, setBackupConfirmed] = useState(false);
  const currentConfirmation = useRef(confirmation);
  const currentBackup = useRef(backupConfirmed);
  useLayoutEffect(() => {
    currentConfirmation.current = confirmation;
    currentBackup.current = backupConfirmed;
  }, [confirmation, backupConfirmed]);
  const body = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const fileId = useId();
  useLayoutEffect(() => {
    if (review) {
      const heading = body.current?.querySelector<HTMLElement>("[data-import-review-heading]");
      heading?.focus({ preventScroll: true });
      heading?.scrollIntoView({ block: "start" });
    }
  }, [review]);
  const impacts = review ? importImpacts(review.selected.body, review.baseline) : [];
  const protectedValues = selected && protectedJson(selected.body, access.prefixes);
  const validReview = !!review && review.approval === access.approval && review.prefix === access.prefixKey;
  const ready =
    validReview &&
    confirmation.text === "정책 가져오기" &&
    (!impacts.some((row) => row.activates) || confirmation.activation) &&
    (!impacts.some((row) => row.removed > 0) || confirmation.removal) &&
    (!protectedValues || confirmation.protected);
  const cause = operation.error;
  const message =
    cause instanceof PolicyImportProblem
      ? cause.message
      : safeAppErrorMessage(cause, "작업을 완료하지 못했습니다. 현재 권한과 연결을 확인하세요.");
  return (
    <Dialog
      open
      title="정책 가져오기"
      description="파일의 대상 정책을 검토한 뒤 명시적으로 적용합니다. 백업 전체 시점 복구나 삭제 기능이 아닙니다."
      returnFocusRef={returnFocusRef}
      onOpenChange={(open) => {
        if (!open) operation.close();
      }}
      footer={
        <>
          <Button aria-disabled={operation.pending} onClick={() => operation.close()}>
            {operation.ack ? "닫기" : "취소"}
          </Button>
          {review && !operation.ack ? (
            <Button
              disabled={operation.pending || operation.unconfirmed}
              onClick={() => operation.edit(review)}
            >
              다시 검토
            </Button>
          ) : null}
          {review && !operation.ack ? (
            <Button
              variant="primary"
              aria-busy={operation.pending}
              aria-disabled={operation.pending || operation.unconfirmed || !access.write.allowed || !ready}
              onClick={() => {
                if (ready && (!protectedValues || confirmation.protected))
                  operation.apply(review, confirmation, () => currentConfirmation.current === confirmation);
              }}
            >
              검토한 정책 적용
            </Button>
          ) : null}
        </>
      }
    >
      <div className="policy-import" ref={body}>
        <div role="region" aria-label="정책 가져오기 읽기 안내" tabIndex={0}>
          파일과 기준은 이 창의 메모리에서만 유지합니다. 원문 표시 보호는 저장된 비밀정보 제거가 아닙니다. 긴
          비교는 방향키와 Page Up·Page Down으로 읽을 수 있습니다.
        </div>
        <section aria-label="정책 백업">
          <h3>현재 정책 원문 백업</h3>
          <p>
            파일에는 민감값이 포함될 수 있습니다. 안전하게 보관하세요. 다시 가져오기는 파일의 대상 정책만
            적용하며, 새 정책 삭제·감사·시각 복원·전체 DB 복구는 하지 않습니다.
          </p>
          <Checkbox
            label="민감값을 포함할 수 있는 원문 백업을 내려받겠습니다"
            checked={backupConfirmed}
            onChange={(event) => setBackupConfirmed(event.target.checked)}
            disabled={operation.pending}
          />
          <Button
            aria-disabled={operation.pending || !backupConfirmed || !access.read}
            aria-busy={operation.phase === "exporting"}
            onClick={() => operation.backup(() => currentBackup.current)}
          >
            현재 정책 백업 내려받기
          </Button>
        </section>
        {!operation.ack ? (
          <>
            <div className="policy-import-file">
              <label htmlFor={fileId}>정책 JSON 파일</label>
              <input
                id={fileId}
                ref={fileInput}
                hidden
                type="file"
                accept="application/json,.json"
                aria-label="정책 JSON 파일"
                disabled={operation.pending || operation.unconfirmed}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) operation.selectFile(file);
                }}
              />
              <Button
                disabled={operation.pending || operation.unconfirmed}
                onClick={() => {
                  if (!operation.pending && !operation.unconfirmed) fileInput.current?.click();
                }}
              >
                JSON 파일 선택
              </Button>
            </div>
            <p>
              4 MiB·정책 1,000개·명시 규칙 10,000개·중첩 64단계 이내입니다. 지원하지 않는 필드와 값이 변할 수
              있는 숫자는 적용 전에 거절합니다. JSON 공백·숫자 표기의 원본 바이트 보존을 보장하지 않습니다.
            </p>
            {selected ? (
              <p>
                선택한 파일: {importDisplay(selected.name, access.prefixes)} · 대상{" "}
                {selected.body.policies.length}개 · 로컬 형식 확인 완료(서버 검증 전)
              </p>
            ) : null}
            {selected && !review ? (
              <Button
                aria-disabled={operation.pending || operation.unconfirmed || !access.write.allowed}
                aria-busy={operation.phase === "planning"}
                onClick={() => operation.prepare(selected)}
              >
                서버 계획 확인
              </Button>
            ) : null}
          </>
        ) : null}
        {!access.write.allowed ? (
          <InlineNotice title="서버 검증과 적용을 실행할 수 없습니다.">
            {access.write.reason} 로컬 파일 확인과 조회 권한이 있는 백업은 사용할 수 있습니다.
          </InlineNotice>
        ) : null}
        {review && !operation.ack ? (
          <>
            <PolicyImportReview review={review} prefixes={access.prefixes} />
            {!validReview ? (
              <InlineNotice tone="warning">
                권한 또는 표시 보호 기준이 바뀌었습니다. 다시 검토하세요.
              </InlineNotice>
            ) : null}
            <fieldset disabled={operation.pending || operation.unconfirmed}>
              <legend>적용 대상 확인</legend>
              <label>
                확인 문구
                <Input
                  aria-label="확인 문구"
                  value={confirmation.text}
                  onChange={(event) => setConfirmation({ ...confirmation, text: event.target.value })}
                />
              </label>
              <p>계속하려면 ‘정책 가져오기’를 정확히 입력하세요.</p>
              {impacts.some((row) => row.activates) ? (
                <Checkbox
                  label="사용 상태인 정책이 요청 처리에 영향을 줄 수 있음을 확인했습니다"
                  checked={confirmation.activation}
                  onChange={(event) => setConfirmation({ ...confirmation, activation: event.target.checked })}
                />
              ) : null}
              {impacts.some((row) => row.removed > 0) ? (
                <Checkbox
                  label="표시된 기존 규칙 제거를 확인했습니다"
                  checked={confirmation.removal}
                  onChange={(event) => setConfirmation({ ...confirmation, removal: event.target.checked })}
                />
              ) : null}
              {protectedValues ? (
                <Checkbox
                  label="보호된 값을 표시 문구가 아닌 원문 그대로 전송함을 확인했습니다"
                  checked={confirmation.protected}
                  onChange={(event) => setConfirmation({ ...confirmation, protected: event.target.checked })}
                />
              ) : null}
            </fieldset>
          </>
        ) : null}
        {operation.unconfirmed && operation.phase !== "saving" ? (
          <InlineNotice tone="warning" title="적용 여부를 확인할 수 없습니다.">
            저장되었을 수 있어 다시 적용과 파일 교체를 잠갔습니다. 현재 내용 다시 조회로 원본이 그대로인지
            확인한 뒤 서버 계획부터 다시 검토하세요. 일반 오류의 자동 재전송은 추가하지 않으며 기존 인증 갱신
            동작은 유지합니다.
          </InlineNotice>
        ) : null}
        {operation.reconciled ? (
          <InlineNotice>
            현재 원본이 이전과 같음을 확인했습니다. 이전 승인은 폐기했으므로 서버 계획부터 다시 검토하세요.
          </InlineNotice>
        ) : null}
        {operation.ack ? (
          <InlineNotice tone="success" title="정책 가져오기 적용 응답을 확인했습니다.">
            생성 {operation.ack.created}개 · 수정 {operation.ack.updated}개. 실제 서버 응답 기준이며 검토 이후
            동시 변경까지 차단하지는 않습니다.
          </InlineNotice>
        ) : null}
        {operation.refreshFailed ? (
          <InlineNotice tone="warning">
            적용 응답은 확인했지만 현재 목록 조회를 마치지 못했습니다. 다시 적용하지 말고 조회만 다시
            시도하세요.
          </InlineNotice>
        ) : null}
        {cause ? (
          <InlineNotice tone="danger" title="확인이 필요합니다.">
            {message}
            {isAppError(cause) && cause.requestId ? (
              <p>요청 ID: {importDisplay(cause.requestId, access.prefixes)}</p>
            ) : null}
          </InlineNotice>
        ) : null}
        {operation.pending ? (
          <p role="status">
            {operation.phase === "saving"
              ? "정책을 적용 중입니다."
              : operation.phase === "reading"
                ? "파일을 확인 중입니다."
                : "정책 기준을 확인 중입니다."}
          </p>
        ) : null}
        {operation.unconfirmed || operation.ack ? (
          <Button
            aria-disabled={operation.pending || !access.read}
            aria-busy={operation.phase === "refreshing"}
            onClick={operation.refresh}
          >
            현재 내용 다시 조회
          </Button>
        ) : null}
      </div>
    </Dialog>
  );
}
export function PolicyImportDialog(props: Props) {
  const coordinator = useUnsavedChanges();
  return coordinator ? (
    <ImportDialog {...props} />
  ) : (
    <UnsavedChangesProvider>
      <ImportDialog {...props} />
    </UnsavedChangesProvider>
  );
}
