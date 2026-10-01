import type { Policy, PolicyBody } from "@/shared/api/domains/governance";
import { editorJson, editorText } from "./policy-editor-security";

export function PolicyEditorReview({
  baseline,
  body,
  prefixes,
}: {
  baseline: Policy;
  body: PolicyBody;
  prefixes: readonly string[];
}) {
  const pairs = [
    ["정책 이름", editorText(baseline.name, prefixes), editorText(body.name, prefixes)],
    ["정책 설명", editorText(baseline.description, prefixes), editorText(body.description, prefixes)],
    ["정책 우선순위", String(baseline.priority), String(body.priority)],
    ["정책 상태", "비활성", "비활성"],
    ["적용 비율", `${baseline.rollout_percent}%`, `${body.rollout_percent}% (유지)`],
  ];
  return (
    <section aria-label="정책 변경 전후 비교">
      <h3 tabIndex={-1} data-editor-review-heading>
        변경 내용 검토
      </h3>
      <p>공백 정리 후 실제 전송할 값을 표시합니다. 표시 보호 문구는 저장 본문으로 보내지 않습니다.</p>
      <table className="policy-editor-comparison">
        <caption>정책 변경 전후</caption>
        <thead>
          <tr>
            <th>항목</th>
            <th>변경 전</th>
            <th>변경 후</th>
          </tr>
        </thead>
        <tbody>
          {pairs.map(([label, before, after]) => (
            <tr key={label}>
              <th scope="row">{label}</th>
              <td>{before}</td>
              <td>{after}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h4>규칙 목록 전체 교체</h4>
      <p>
        기존 {baseline.rules?.length ?? 0}개 → 저장 후 {body.rules.length}개. 새 규칙 ID는 서버가 부여하며,
        유지한 규칙 ID는 그대로 보냅니다.
      </p>
      <div className="policy-editor-rule-comparison">
        <section aria-label="변경 전 규칙">
          <h4>변경 전 규칙</h4>
          {baseline.rules?.map((rule, index) => (
            <article key={index}>
              <h5>
                규칙 {index + 1}: {editorText(rule.name, prefixes)}
              </h5>
              <p>ID: {editorText(rule.id, prefixes)}</p>
              <p>
                {rule.enabled === true ? "사용" : rule.enabled === false ? "중지" : "상태 미확인"} · 우선순위{" "}
                {String(rule.priority ?? "미확인")}
              </p>
              <pre>{editorJson(rule.conditions, prefixes)}</pre>
              <pre>{editorJson(rule.actions, prefixes)}</pre>
            </article>
          ))}
        </section>
        <section aria-label="변경 후 규칙">
          <h4>변경 후 규칙</h4>
          {body.rules.map((rule, index) => (
            <article key={index}>
              <h5>
                규칙 {index + 1}: {editorText(rule.name, prefixes)}
              </h5>
              <p>ID: {rule.id ? editorText(rule.id, prefixes) : "새 규칙"}</p>
              <p>
                {rule.enabled ? "사용" : "중지"} · 우선순위 {rule.priority}
              </p>
              <pre>{editorJson(rule.conditions, prefixes)}</pre>
              <pre>{editorJson(rule.actions, prefixes)}</pre>
            </article>
          ))}
        </section>
      </div>
    </section>
  );
}
