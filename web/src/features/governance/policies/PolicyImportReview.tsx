import { useState } from "react";
import { Button } from "@/shared/components/ui/Button";
import { importDisplay, importImpacts } from "./policy-import-state";
import type { ImportReview } from "./policy-import-operation";

const metadataDisplay = (key: string, value: unknown, prefixes: readonly string[]) =>
  key === "enabled" && typeof value === "boolean"
    ? value
      ? "사용"
      : "중지"
    : importDisplay(value, prefixes);

export function PolicyImportReview({
  review,
  prefixes,
}: {
  review: ImportReview;
  prefixes: readonly string[];
}) {
  const [page, setPage] = useState(0);
  const impacts = importImpacts(review.selected.body, review.baseline);
  const count = Math.ceil(impacts.length / 20);
  const shown = Math.min(page, Math.max(0, count - 1));
  return (
    <section aria-label="정책 가져오기 전후 비교">
      <h3 tabIndex={-1} data-import-review-heading>
        서버 계획과 변경 내용
      </h3>
      <p>
        대상 {impacts.length}개 · 생성 예정 {review.plan.created}개 · 수정 예정 {review.plan.updated}개
      </p>
      <p>
        계획의 규칙 수는 파일에 명시된 수입니다. 생략·null은 기존 규칙 유지이며 0개 제거를 뜻하지 않습니다.
      </p>
      <p>
        정책 사용 상태와 기본값을 반영한 예상 내용입니다. 수정 시각은 서버가 새로 기록하며 기존 정책 생성
        시각은 유지합니다. 규칙 생성 시각은 입력이 없으면 새로 기록합니다.
      </p>
      <p>
        규칙의 rollout_percent는 별도로 저장되지 않습니다. 실제 실행 비율은 소유 정책의 적용 비율을 따릅니다.
      </p>
      <p>
        저장 직전에 다시 조회하지만 서버 CAS가 아니므로 동시 변경을 막지는 못합니다. 감사는 별도 최선 노력
        기록이고 후속 모의 검사가 발생할 수 있습니다. 다른 서버는 기존 캐시가 만료된 후 반영할 수 있습니다.
      </p>
      <p>
        {shown + 1} / {count}쪽 · 한 쪽에 최대 20개 정책을 표시합니다.
      </p>
      <div className="policy-import-actions">
        <Button disabled={shown === 0} onClick={() => setPage((value) => value - 1)}>
          이전 정책
        </Button>
        <Button disabled={shown + 1 >= count} onClick={() => setPage((value) => value + 1)}>
          다음 정책
        </Button>
      </div>
      <ol start={shown * 20 + 1} className="policy-import-reviews">
        {impacts.slice(shown * 20, shown * 20 + 20).map((row, index) => (
          <li key={index}>
            <h4>{importDisplay(row.after.name, prefixes)}</h4>
            <p>
              정책 ID: {importDisplay(row.after.id, prefixes)} ·{" "}
              {row.before ? "기존 정책 수정" : "새 정책 생성"}
            </p>
            <p>
              {row.mode} · 제거되는 기존 규칙 {row.removed}개 · 적용 후 {row.after.enabled ? "사용" : "중지"}
            </p>
            <table>
              <caption>정책 {shown * 20 + index + 1} 메타데이터 전후</caption>
              <thead>
                <tr>
                  <th>항목</th>
                  <th>현재</th>
                  <th>적용 예상</th>
                </tr>
              </thead>
              <tbody>
                {(
                  [
                    ["name", "이름"],
                    ["description", "설명"],
                    ["enabled", "사용 상태"],
                    ["priority", "우선순위"],
                    ["rollout_percent", "적용 비율"],
                  ] as const
                ).map(([key, label]) => (
                  <tr key={key}>
                    <th>{label}</th>
                    <td>{metadataDisplay(key, row.before?.[key], prefixes)}</td>
                    <td>{metadataDisplay(key, row.after[key], prefixes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <details>
              <summary>현재 규칙과 적용 예상 규칙 읽기</summary>
              <p>기존 규칙</p>
              <pre>{importDisplay(row.before?.rules ?? [], prefixes)}</pre>
              <p>적용 예상 규칙</p>
              <pre>{importDisplay(row.after.rules, prefixes)}</pre>
            </details>
          </li>
        ))}
      </ol>
    </section>
  );
}
