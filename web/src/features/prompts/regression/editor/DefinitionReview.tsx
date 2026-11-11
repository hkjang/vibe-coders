import { useEffect, useRef } from "react";
import { safeRegressionText } from "../regression-model";
import {
  definitionBody,
  definitionDefaults,
  type DefinitionTarget,
  type DefinitionValues,
} from "./definition-form";

export function DefinitionReview({
  target,
  values,
  prefixes,
}: {
  target: DefinitionTarget;
  values: DefinitionValues;
  prefixes: readonly string[];
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  const before = definitionDefaults(target);
  const after = definitionBody(target, values);
  const normalizedBefore = definitionBody(target, { ...before, tags: target.original?.tags ?? [] });
  const fields = [
    { label: "이름", before: before.name, after: values.name },
    {
      label: "태그",
      before: JSON.stringify(target.original?.tags ?? [], null, 2),
      after: JSON.stringify(values.tags, null, 2),
    },
    ...(target.kind === "prompt"
      ? [
          { label: "기준 프롬프트", before: before.prompt, after: values.prompt },
          { label: "기대 내용", before: before.expected, after: values.expected },
        ]
      : [
          { label: "설명", before: before.description, after: values.description },
          {
            label: "검증 단계와 출처",
            before: "steps" in normalizedBefore ? JSON.stringify(normalizedBefore.steps, null, 2) : "",
            after: "steps" in after ? JSON.stringify(after.steps, null, 2) : "",
          },
        ]),
  ];
  return (
    <section className="page-stack" aria-label="정의 변경 비교">
      <h3 ref={heading} tabIndex={-1}>
        저장 전 변경 비교
      </h3>
      <p>
        저장하면 이 정의를 사용하는 다음 회귀 검사에 반영됩니다. 기존 실행 결과와 모델 설정은 변경되지
        않습니다.
      </p>
      <p className="muted">
        편집을 시작한 값과 비교합니다. 저장 직전에 다시 조회하지만 서버가 동시 변경을 원자적으로 차단하지는
        않습니다.
      </p>
      <div className="regression-diff-scroll" tabIndex={0} role="region" aria-label="정의 변경 비교 표">
        <table className="regression-diff">
          <caption>정의 필드별 변경 전후</caption>
          <thead>
            <tr>
              <th scope="col">항목</th>
              <th scope="col">변경 전</th>
              <th scope="col">저장할 값</th>
            </tr>
          </thead>
          <tbody>
            {fields.map((field) => (
              <tr
                key={field.label}
                data-changed={!target.original || field.before !== field.after ? "true" : undefined}
              >
                <th scope="row">
                  {field.label}
                  {!target.original || field.before !== field.after ? " · 변경" : " · 동일"}
                </th>
                <td>
                  <pre tabIndex={0} aria-label={`${field.label} 변경 전`}>
                    {target.original
                      ? safeRegressionText(field.before, prefixes) || "(비어 있음)"
                      : "(새 항목)"}
                  </pre>
                </td>
                <td>
                  <pre tabIndex={0} aria-label={`${field.label} 저장할 값`}>
                    {safeRegressionText(field.after, prefixes) || "(비어 있음)"}
                  </pre>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
