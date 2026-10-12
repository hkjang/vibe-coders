import { useState } from "react";
import { useMeOnboardingPackQuery } from "./use-me-queries";
import { severityTone } from "@/features/access/access-format";
import { QueryNotice } from "@/features/access/access-ui";
import { apiClient } from "@/shared/api/client";
import type { ConnectionDoctorBody } from "@/shared/api/domains/access";
import { endpoints } from "@/shared/api/endpoints";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { JsonBlock } from "@/shared/components/ui/JsonBlock";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";

const routeId = "me.home";
const doctorClients = [
  { value: "openai-sdk", label: "OpenAI SDK" },
  { value: "cursor", label: "Cursor (MCP)" },
  { value: "roo", label: "Roo (MCP)" },
  { value: "cline", label: "Cline (MCP)" },
  { value: "claude-desktop-mcp", label: "Claude Desktop (MCP)" },
  { value: "claude", label: "Claude (MCP)" },
  { value: "mcp", label: "MCP 일반" },
] as const;

interface Props {
  owner: string;
  canWrite: boolean;
  ownsResult: () => boolean;
  assertCurrent: () => void;
}
export function MeConnectionTools({ owner, canWrite, ownsResult, assertCurrent }: Props): React.JSX.Element {
  const [doctorClient, setDoctorClient] = useState("openai-sdk");
  const [packClient, setPackClient] = useState("openai-sdk");
  const [packRequested, setPackRequested] = useState(false);
  const pack = useMeOnboardingPackQuery(packClient, packRequested, owner);

  const doctor = useMutationFeedback({
    ownsResult,
    mutate: (body: ConnectionDoctorBody) => {
      assertCurrent();
      return apiClient.request(endpoints.domains.access.me.connectionDoctor, {
        body,
        routeId,
        retryUnauthorized: false,
      });
    },
    successMessage: "연결 진단을 마쳤습니다.",
  });

  return (
    <>
      <SectionCard
        title="연결 진단"
        description="개발 도구가 게이트웨이에 연결될 수 있는지 확인합니다."
        actions={
          <div className="access-inline-actions">
            <label className="access-toolbar-field">
              <span>클라이언트</span>
              <Select value={doctorClient} onChange={(event) => setDoctorClient(event.target.value)}>
                {doctorClients.map((client) => (
                  <option key={client.value} value={client.value}>
                    {client.label}
                  </option>
                ))}
              </Select>
            </label>
            <Button
              variant="primary"
              disabled={!canWrite || doctor.isPending}
              onClick={() => doctor.mutate({ client: doctorClient })}
            >
              {doctor.isPending ? "진단 중" : "진단 실행"}
            </Button>
          </div>
        }
      >
        {doctor.data ? (
          <div className="access-stack">
            <KeyValueList
              items={[
                { label: "클라이언트", value: doctor.data.client },
                { label: "종합", value: doctor.data.overall },
                { label: "기본 주소", value: doctor.data.base_url, mono: true },
                { label: "MCP 주소", value: doctor.data.mcp_url, mono: true },
                { label: "인증 방식", value: doctor.data.auth_mode },
              ]}
            />
            <ul className="access-list">
              {doctor.data.checks.map((check, index) => (
                <li key={`${check.name}-${String(index)}`}>
                  <span className="access-list-title">
                    <Badge tone={check.status === "skip" ? "muted" : severityTone(check.status)}>
                      {check.status === "skip" ? "건너뜀" : check.status}
                    </Badge>
                    {check.name}
                  </span>
                  <span className="access-list-detail">{check.detail}</span>
                  {check.fix ? <span className="access-list-detail">조치: {check.fix}</span> : null}
                </li>
              ))}
            </ul>
            {doctor.data.note ? <p className="access-note">{doctor.data.note}</p> : null}
          </div>
        ) : (
          <p className="access-note">
            클라이언트를 고르고 '진단 실행'을 누르면 연결 가능 여부와 조치 방법을 알려 드립니다. 진단 결과에
            '건너뜀'으로 표시된 항목은 등급 계산에서 제외됩니다.
          </p>
        )}
      </SectionCard>

      <SectionCard
        title="개발도구 연결 설정"
        description="선택한 클라이언트에 맞는 접속 정보와 설정 예시입니다."
        actions={
          <div className="access-inline-actions">
            <label className="access-toolbar-field">
              <span>클라이언트</span>
              <Select value={packClient} onChange={(event) => setPackClient(event.target.value)}>
                {doctorClients.map((client) => (
                  <option key={client.value} value={client.value}>
                    {client.label}
                  </option>
                ))}
              </Select>
            </label>
            <Button onClick={() => setPackRequested(true)} disabled={pack.isFetching}>
              {pack.isFetching ? "불러오는 중" : "설정 불러오기"}
            </Button>
          </div>
        }
      >
        {!packRequested ? (
          <p className="access-note">'설정 불러오기'를 누르면 접속 URL과 설정 예시를 표시합니다.</p>
        ) : pack.isError ? (
          <QueryNotice
            error={pack.error}
            hasData={Boolean(pack.data)}
            label="연결 설정"
            onRetry={() => void pack.refetch()}
          />
        ) : pack.data ? (
          <div className="access-stack">
            <KeyValueList
              items={[
                { label: "기본 주소", value: pack.data.base_url, mono: true },
                { label: "MCP 주소", value: pack.data.mcp_url, mono: true },
                { label: "추천 모델", value: pack.data.recommended_models.join(", ") },
                { label: "권한", value: pack.data.scopes.join(", ") },
              ]}
            />
            {pack.data.config !== undefined && pack.data.config !== null ? (
              <JsonBlock label={pack.data.config_label || "설정"} value={pack.data.config} />
            ) : null}
            {pack.data.mcp_config !== undefined && pack.data.mcp_config !== null ? (
              <JsonBlock label="MCP 설정" value={pack.data.mcp_config} />
            ) : null}
            {pack.data.note ? <p className="access-note">{pack.data.note}</p> : null}
          </div>
        ) : null}
      </SectionCard>
    </>
  );
}
