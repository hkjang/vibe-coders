import { useState } from "react";
import { UpdatedAt } from "@/features/access/access-ui";
import { Badge, type BadgeProps } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { CopyButton } from "@/shared/components/ui/CopyButton";
import { FormField } from "@/shared/components/form/FormField";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { useMeOnboardingPackQuery, useMeDoctorQuery } from "./use-me-queries";
import { MeQueryContent } from "./me-console-ui";
import { meError, safeMeMessage } from "./me-console-model";
import {
  connectionClient,
  connectionClients,
  connectionExamples,
  doctorCheckLabel,
  doctorStatus,
  type ConnectionClient,
} from "./me-access-model";

interface Props {
  canWrite: boolean;
  ownsResult: () => boolean;
  assertCurrent: () => void;
}
const tones: Readonly<Record<keyof typeof doctorStatus, BadgeProps["tone"]>> = {
  pass: "success",
  warn: "warning",
  fail: "danger",
  skip: "muted",
};
export function MeConnectionTools(props: Props) {
  const [params, update] = useSearchState();
  const client = connectionClient(params.get("connection_client"));
  return (
    <>
      <SectionCard
        title="개발 도구 연결"
        description="연결할 도구를 선택한 뒤 설정 예시를 확인하거나 연결 상태를 진단하세요."
      >
        <FormField label="클라이언트">
          {(control) => (
            <Select
              {...control}
              value={client}
              onChange={(event) => update({ connection_client: connectionClient(event.target.value) })}
            >
              {connectionClients.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </Select>
          )}
        </FormField>
      </SectionCard>
      <ConnectionContent key={client} {...props} client={client} />
    </>
  );
}
function Example({ label, value }: { label: string; value: string }) {
  return (
    <section className="me-connection-example" aria-label={label}>
      <div className="me-connection-example-header">
        <h3>{label}</h3>
        <CopyButton label={label + " 복사"} value={value} />
      </div>
      <pre tabIndex={0} role="region" aria-label={label + " 내용"}>
        <code>{value}</code>
      </pre>
    </section>
  );
}
function ConnectionContent({
  canWrite,
  ownsResult,
  assertCurrent,
  client,
}: Props & { client: ConnectionClient }) {
  const [packRequested, setPackRequested] = useState(false);
  const [actionError, setActionError] = useState("");
  const pack = useMeOnboardingPackQuery(client, packRequested);
  const doctor = useMeDoctorQuery(client);
  const examples = pack.data ? connectionExamples(pack.data.base_url, pack.data.mcp_url) : undefined;
  const runDoctor = async () => {
    try {
      assertCurrent();
      if (!canWrite || !ownsResult()) throw meError("changed");
      setActionError("");
      await doctor.refetch();
    } catch (error) {
      setActionError(safeMeMessage(error));
    }
  };
  return (
    <div className="me-connection-grid">
      <SectionCard
        title="연결 설정"
        description="비밀값이 없는 설정 예시입니다. 발급한 키는 사용하는 개발 도구에 직접 입력하세요."
        actions={
          <Button
            disabled={pack.isFetching}
            onClick={() => {
              if (packRequested) void pack.refetch();
              else setPackRequested(true);
            }}
          >
            {pack.isFetching ? "불러오는 중" : "설정 불러오기"}
          </Button>
        }
      >
        {!packRequested ? (
          <p className="access-note">‘설정 불러오기’를 누르면 이 도구의 연결 주소와 설정을 표시합니다.</p>
        ) : (
          <MeQueryContent query={pack} label="연결 설정">
            {pack.data && examples ? (
              <div className="access-stack">
                <KeyValueList
                  columns={1}
                  items={[
                    { label: "모델 API 주소", value: pack.data.base_url, mono: true },
                    { label: "MCP 주소", value: pack.data.mcp_url, mono: true },
                  ]}
                />
                <KeyValueList
                  items={[
                    { label: "추천 모델", value: pack.data.recommended_models.join(", ") || "없음" },
                    { label: "사용 권한", value: pack.data.scopes.join(", ") || "없음" },
                  ]}
                />
                <InlineNotice tone="info">
                  {"<YOUR_API_KEY>"}를 본인이 발급한 키로 바꾸세요. 이 화면에서는 키의 전체 값을 입력하거나
                  저장하지 않습니다.
                </InlineNotice>
                {client === "openai-sdk" ? <Example label="Python SDK 설정" value={examples.sdk} /> : null}
                <Example label="HTTP MCP 설정" value={examples.mcp} />
                <p className="access-note">
                  사용하는 도구와 버전의 HTTP MCP 지원 여부를 확인한 뒤 설정을 적용하세요.
                </p>
                <details>
                  <summary>사용 가능한 모델 {pack.data.available_models.length}개</summary>
                  <p className="me-period-note">
                    {pack.data.available_models.join(", ") || "등록된 모델이 없습니다."}
                  </p>
                </details>
                <UpdatedAt at={pack.dataUpdatedAt} />
              </div>
            ) : null}
          </MeQueryContent>
        )}
      </SectionCard>
      <SectionCard
        title="연결 진단"
        description="인증·권한·모델·한도 설정을 확인합니다. 브라우저 로그인에서는 실제 모델·MCP 연결 검사를 수행하지 않습니다."
        actions={
          <Button
            variant="primary"
            disabled={!canWrite || doctor.isFetching}
            onClick={() => void runDoctor()}
          >
            {doctor.isFetching ? "진단 중" : "진단 실행"}
          </Button>
        }
      >
        {!canWrite ? (
          <InlineNotice tone="info">읽기 전용 상태에서는 연결 진단을 실행할 수 없습니다.</InlineNotice>
        ) : null}
        {actionError ? <InlineNotice tone="warning">{actionError}</InlineNotice> : null}
        {doctor.isFetching ? (
          <p role="status">진단 중입니다. 표시된 결과가 있다면 이전 검사 결과입니다.</p>
        ) : null}
        {!doctor.isFetched && !doctor.isFetching ? (
          <p className="access-note">
            진단은 버튼을 눌렀을 때 실행합니다. 모델 응답 생성이나 설정 저장은 하지 않습니다.
          </p>
        ) : (
          <MeQueryContent
            query={{ ...doctor, refetch: runDoctor }}
            label="연결 진단"
            retryDisabled={!canWrite || doctor.isFetching}
          >
            {doctor.data ? (
              <div className="access-stack">
                <p>
                  <Badge tone={tones[doctor.data.overall]}>{doctorStatus[doctor.data.overall]}</Badge> ·{" "}
                  {doctor.data.auth_mode === "jwt"
                    ? "브라우저 로그인 설정 검사"
                    : doctor.data.auth_mode === "proxy_key"
                      ? "API 키 연결 검사"
                      : "인증 상태 확인 필요"}
                </p>
                {doctor.data.auth_mode === "jwt" ? (
                  <InlineNotice tone="info">
                    실제 연결 성공 여부는 발급한 키를 설정한 개발 도구에서 확인하세요. 아래 ‘검사 안 함’은
                    성공한 검사가 아닙니다.
                  </InlineNotice>
                ) : null}
                <ul className="me-doctor-checks">
                  {doctor.data.checks.map((check) => (
                    <li key={check.name}>
                      <div className="me-connection-example-header">
                        <h3>{doctorCheckLabel(check.name)}</h3>
                        <Badge tone={tones[check.status]}>{doctorStatus[check.status]}</Badge>
                      </div>
                      <p>{check.detail || "상세 안내가 없습니다."}</p>
                      {check.fix ? <p className="access-note">해결 안내: {check.fix}</p> : null}
                    </li>
                  ))}
                </ul>
                <UpdatedAt at={doctor.dataUpdatedAt} />
              </div>
            ) : null}
          </MeQueryContent>
        )}
      </SectionCard>
    </div>
  );
}
