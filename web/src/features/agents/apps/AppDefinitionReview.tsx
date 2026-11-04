import type { AppFormOutput } from "./app-form";
import type { WorkApp } from "@/shared/api/domains/agents.schemas";
import { containsPotentialSecret } from "@/shared/security/secrets";
import "./app-definition-review.css";

export function AppDefinitionReview({
  app,
  values,
  prefixes,
}: {
  app?: WorkApp;
  values: AppFormOutput;
  prefixes: readonly string[];
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  const text = (value: string | undefined): string =>
    value === undefined
      ? "미확인"
      : value === ""
        ? "미설정"
        : containsPotentialSecret(value, prefixes)
          ? "민감한 값은 비교에 표시하지 않습니다."
          : value;
  const status = (value?: string) =>
    value === "active" ? "활성" : value === "archived" ? "보관" : text(value);
  const rows = [
    ["제목", app?.title, values.title],
    ["설명", app?.description, values.description],
    ["아이콘", app?.icon, values.icon],
    ["허용 팀", app?.allowed_teams, values.allowed_teams],
    ["허용 역할", app?.allowed_roles, values.allowed_roles],
    ["상태", status(app?.status), status(values.status)],
    [
      "구성 요소",
      app?.components == null ? undefined : JSON.stringify(app.components, null, 2),
      JSON.stringify(values.components, null, 2),
    ],
  ];
  return (
    <section className="app-definition-review" aria-label="업무 앱 변경 검토">
      <h3 ref={heading} tabIndex={-1}>
        변경 내용과 적용 범위
      </h3>
      <p>
        공백 정리 후 전송할 값을 비교합니다. 다시 입력하면 검토 확인이 해제됩니다. 민감한 값의 표시 보호는
        저장 본문을 바꾸지 않습니다.
      </p>
      <p>
        활성 앱의 정의 저장은 노출·구성에 바로 영향을 줄 수 있습니다. 팀·역할 조건을 비우면 접근 범위가 넓어질
        수 있으며, 기존 추가 접근 권한은 좁아지지 않습니다. 발행 버전 생성은 별도 작업입니다.
      </p>
      <p>
        편집 시작 시점과 비교하며 다른 관리자의 동시 변경이나 전체 참조 영향도는 검증하지 않습니다. 필요하면
        저장 전에 취소하고 최신 목록을 다시 확인하세요.
      </p>
      <div
        className="app-definition-review-scroll"
        tabIndex={0}
        role="region"
        aria-label="업무 앱 변경 전후 비교 영역"
      >
        <table>
          <caption>업무 앱 변경 전후</caption>
          <thead>
            <tr>
              <th scope="col">항목</th>
              <th scope="col">변경 전</th>
              <th scope="col">저장할 값</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, before, after]) => (
              <tr key={label} data-changed={!app || before !== after}>
                <th scope="row">
                  {label}
                  {!app || before !== after ? " · 변경" : " · 유지"}
                </th>
                <td>{app ? text(before) : "신규 앱"}</td>
                <td>{text(after)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
import { useEffect, useRef } from "react";
