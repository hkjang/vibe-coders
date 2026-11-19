import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useAuth } from "@/app/auth/AuthProvider";
import { Button } from "@/shared/components/ui/Button";
import { Checkbox } from "@/shared/components/ui/Checkbox";
import { Dialog } from "@/shared/components/ui/Dialog";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { containsPotentialSecret } from "@/shared/security/secrets";
import { useUnsavedChanges } from "@/shared/unsaved/context";
import { UnsavedChangesProvider } from "@/shared/unsaved/UnsavedChangesProvider";
import type { ProbeCsvChange } from "@/shared/api/domains/redteam-probe-csv-review";
import type { ProbeCsvImportOperation } from "./use-probe-csv-import";
import { formatNumber } from "@/shared/utils/format";
import "./probe-csv-review.css";

interface Props {
  operation: ProbeCsvImportOperation;
  returnFocusRef: RefObject<HTMLElement | null>;
}
const labels: Record<string, string> = {
  id: "ID",
  name: "묶음 이름",
  category: "분류",
  severity: "심각도",
  version: "버전",
  enabled: "사용 상태",
  requires_approval: "승인 필요",
  pack_id: "소속 묶음 ID",
  case_key: "검사 키",
  input_template: "요청 프롬프트",
  expected_policy: "기대 정책",
  evaluator_type: "평가 방식",
  risk_tags: "위험 태그",
  target_types: "대상 유형",
};
const actions = { create: "새로 생성", update: "수정", unchanged: "변경 없음" };
function display(value: unknown, prefixes: readonly string[]): string {
  if (value === undefined) return "없음";
  if (value === true) return "예";
  if (value === false) return "아니요";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (containsPotentialSecret(text, prefixes)) return "민감정보가 포함될 수 있어 표시하지 않습니다.";
  return typeof value === "string" ? JSON.stringify(value) : text;
}
function Comparison({
  change,
  index,
  prefixes,
}: {
  change: ProbeCsvChange;
  index: number;
  prefixes: readonly string[];
}) {
  const before = change.before as Record<string, unknown> | null;
  return (
    <li>
      <h4>
        {index}. {change.kind === "pack" ? "묶음" : "검사"} · {actions[change.action]}
      </h4>
      <p>{display(change.kind === "pack" ? change.after.name : change.after.case_key, prefixes)}</p>
      <table>
        <caption>
          {index}번 {change.kind === "pack" ? "묶음" : "검사"} 변경 전후
        </caption>
        <thead>
          <tr>
            <th scope="col">항목</th>
            <th scope="col">현재</th>
            <th scope="col">적용 후</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(change.after).map(([key, value]) => (
            <tr
              key={key}
              className={
                JSON.stringify(before?.[key]) !== JSON.stringify(value) ? "probe-csv-changed" : undefined
              }
            >
              <th scope="row">{labels[key] ?? key}</th>
              <td>
                <pre tabIndex={0} aria-label={(labels[key] ?? key) + " 현재 값"}>
                  {display(before?.[key], prefixes)}
                </pre>
              </td>
              <td>
                <pre tabIndex={0} aria-label={(labels[key] ?? key) + " 적용 후 값"}>
                  {display(value, prefixes)}
                </pre>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </li>
  );
}
function ImportDialog({ operation, returnFocusRef }: Props) {
  const { credentialPrefixes } = useAuth();
  const coordinator = useUnsavedChanges();
  const [formId] = useState(() => Symbol("probe-csv-review"));
  const close = useRef(operation.close);
  useLayoutEffect(() => {
    close.current = operation.close;
  }, [operation.close]);
  useLayoutEffect(() => () => coordinator?.removeForm(formId), [coordinator, formId]);
  useLayoutEffect(() => {
    coordinator?.setForm(formId, { dirty: true, pending: operation.pending, discard: () => close.current() });
  }, [coordinator, formId, operation.pending]);
  const { review } = operation;
  const [confirmation, setConfirmation] = useState({ review, checked: false });
  if (confirmation.review !== review) setConfirmation({ review, checked: false });
  const heading = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    if (review) heading.current?.focus({ preventScroll: true });
  }, [review]);
  const ready = !!review && confirmation.review === review && confirmation.checked && !operation.pending;
  const requestClose = () => (coordinator ? coordinator.requestClose(formId) : operation.close());
  const apply = async () => {
    if (!ready || !review || (coordinator && !coordinator.startSubmission(formId))) return;
    try {
      await operation.apply(review.revision);
    } finally {
      coordinator?.finishSubmission(formId);
    }
  };
  return (
    <Dialog
      open
      title="CSV 변경 내용 확인"
      description="변경 전후를 확인한 뒤 선택한 파일 전체를 적용합니다."
      returnFocusRef={returnFocusRef}
      onOpenChange={(open) => {
        if (!open) requestClose();
      }}
      scrollBody
      wide
      scrollBodyLabel="CSV 변경 비교"
      footer={
        <>
          <Button disabled={operation.pending} onClick={requestClose}>
            취소
          </Button>
          <Button disabled={!ready} onClick={() => void apply()}>
            {operation.stage === "applying" && operation.pending ? "적용 중…" : "변경 내용 적용"}
          </Button>
        </>
      }
    >
      <div className="probe-csv-review">
        <p>파일: {display(operation.filename, credentialPrefixes)}</p>
        <p>
          파일은 8 MiB·10,000행까지 검토할 수 있습니다. 기존 실행 파라미터와 파일에 없는 검사는 유지됩니다.
        </p>
        <p>민감정보가 포함될 수 있는 값은 가려 표시하며, 적용 시 원본 파일의 값을 사용합니다.</p>
        {operation.pending ? (
          <p role="status">
            {operation.stage === "reading"
              ? "CSV 파일을 확인하고 있습니다."
              : operation.stage === "reviewing"
                ? "변경 전후를 확인하고 있습니다."
                : "가져오기 적용 결과를 기다리고 있습니다."}
          </p>
        ) : null}
        {operation.error ? (
          <InlineNotice tone="danger">
            {operation.error.message}
            {operation.error.requestId ? (
              <p>요청 ID: {display(operation.error.requestId, credentialPrefixes)}</p>
            ) : null}
          </InlineNotice>
        ) : null}
        {operation.canReviewAgain ? (
          <Button disabled={operation.pending} onClick={() => void operation.reviewAgain()}>
            현재 내용으로 다시 검토
          </Button>
        ) : null}
        {review ? (
          <section aria-label="CSV 변경 전후">
            <h3 ref={heading} tabIndex={-1}>
              적용 예정 내용
            </h3>
            <p>
              생성 {formatNumber(review.counts.created)}개 · 수정 {formatNumber(review.counts.updated)}개 ·
              변경 없음 {formatNumber(review.counts.unchanged)}개
            </p>
            <p>
              프롬프트 {formatNumber(review.imported_cases)}행 · 묶음 {formatNumber(review.packs_touched)}개 ·
              건너뛴 행 {formatNumber(review.skipped.length)}개
            </p>
            <p>
              중복 검사 ID는 마지막 행을 반영합니다. 전체 {formatNumber(review.total_items)}개 항목 중{" "}
              {formatNumber(review.offset + 1)}–{formatNumber(review.offset + review.changes.length)}개를
              표시합니다.
            </p>
            {review.skipped.length > 0 ? (
              <InlineNotice tone="warning">
                검사 키 또는 요청 프롬프트가 없는 행은 적용하지 않습니다. 나머지 행을 함께 적용합니다.
              </InlineNotice>
            ) : null}
            <div className="probe-csv-review-actions">
              <Button
                disabled={operation.pending || review.offset === 0}
                onClick={() => void operation.goTo(Math.max(0, review.offset - review.limit))}
              >
                이전 변경
              </Button>
              <Button
                disabled={operation.pending || !review.has_more}
                onClick={() => void operation.goTo(review.offset + review.limit)}
              >
                다음 변경
              </Button>
            </div>
            <ol className="probe-csv-review-list" start={review.offset + 1}>
              {review.changes.map((change, index) => (
                <Comparison
                  key={change.kind + ":" + change.id}
                  change={change}
                  index={review.offset + index + 1}
                  prefixes={credentialPrefixes}
                />
              ))}
            </ol>
            <Checkbox
              label={
                "변경 내용을 확인했으며 전체 " +
                formatNumber(review.total_items) +
                "개 항목에 원본 파일을 적용합니다"
              }
              checked={confirmation.review === review && confirmation.checked}
              disabled={operation.pending}
              onChange={(event) => setConfirmation({ review, checked: event.target.checked })}
            />
          </section>
        ) : null}
      </div>
    </Dialog>
  );
}
export default function ProbeCsvImportDialog(props: Props) {
  const coordinator = useUnsavedChanges();
  return coordinator ? (
    <ImportDialog {...props} />
  ) : (
    <UnsavedChangesProvider>
      <ImportDialog {...props} />
    </UnsavedChangesProvider>
  );
}
