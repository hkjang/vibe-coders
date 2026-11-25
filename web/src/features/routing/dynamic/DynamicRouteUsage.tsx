import { CopyButton } from "@/shared/components/ui/CopyButton";
import { SectionCard } from "@/shared/components/ui/SectionCard";

import { callSnippet, sdkSnippet } from "./dynamic-route-model";

const requestHeaders: ReadonlyArray<{ name: string; alias: string; description: string }> = [
  {
    name: "X-Vibe-Metadata",
    alias: "cf-aig-metadata",
    description:
      "조건·고정 분배·한도 키가 읽는 JSON 객체입니다. 최대 16개 항목, 값은 문자열·숫자·불리언입니다. 저장할 때 개인정보는 마스킹됩니다.",
  },
  {
    name: "X-Vibe-Request-Timeout",
    alias: "cf-aig-request-timeout",
    description: "공급자의 첫 응답을 기다리는 시간(ms)입니다. 모델 요소에 정한 값이 우선합니다.",
  },
  {
    name: "X-Vibe-Max-Attempts",
    alias: "cf-aig-max-attempts",
    description: "공급자 한 곳에 보내는 최대 횟수(1~5)입니다. 429·5xx·연결 오류 때 다시 보냅니다.",
  },
  {
    name: "X-Vibe-Retry-Delay",
    alias: "cf-aig-retry-delay",
    description: "재시도 전 대기 시간(ms, 최대 60000)입니다.",
  },
  {
    name: "X-Vibe-Backoff",
    alias: "cf-aig-backoff",
    description: "constant · linear · exponential 중 하나입니다.",
  },
  {
    name: "X-Vibe-Skip-Cache",
    alias: "cf-aig-skip-cache",
    description: "true면 응답 캐시를 읽지도 쓰지도 않습니다. 응답의 X-Cache가 BYPASS가 됩니다.",
  },
  {
    name: "X-Vibe-Cache-TTL",
    alias: "cf-aig-cache-ttl",
    description: "이 응답을 캐시에 둘 시간(초)입니다. 운영자가 정한 TTL보다 길게는 늘릴 수 없습니다.",
  },
];

const responseHeaders: ReadonlyArray<{ name: string; description: string }> = [
  { name: "X-Dynamic-Route / -Version", description: "요청을 처리한 경로 이름과 배포 버전" },
  {
    name: "X-Dynamic-Route-Path",
    description: "지나간 요소와 각 결정. 예: start>plan:true>cheap:success>end",
  },
  { name: "X-Dynamic-Route-Element", description: "마지막으로 시도한 모델 요소" },
  { name: "X-Routed-Model / X-Provider", description: "실제로 응답한 모델과 공급자" },
  { name: "X-Upstream-Retries", description: "재시도 횟수 (재시도했을 때만)" },
  {
    name: "X-Dynamic-Route-Limit / Retry-After",
    description: "한도로 거절됐을 때 그 한도 요소와 다시 시도할 시각",
  },
];

export function DynamicRouteUsage({ callModel }: { callModel: string }): React.JSX.Element {
  const origin = typeof window === "undefined" ? "https://gateway.example" : window.location.origin;
  const curl = callSnippet(callModel, origin);
  const sdk = sdkSnippet(callModel, origin);
  return (
    <div className="dr-usage">
      <SectionCard
        title="호출 예시"
        description="OpenAI 호환 요청에서 모델 이름만 바꾸면 됩니다. /v1/chat/completions, /v1/responses, /v1/messages, /v1/completions, /v1/embeddings에서 쓸 수 있습니다."
        actions={<CopyButton value={curl} label="curl 예시 복사" />}
      >
        <pre className="dr-snippet">
          <code>{curl}</code>
        </pre>
        <div className="dr-snippet-head">
          <h3>OpenAI Python SDK</h3>
          <CopyButton value={sdk} label="Python 예시 복사" />
        </div>
        <pre className="dr-snippet">
          <code>{sdk}</code>
        </pre>
      </SectionCard>
      <SectionCard
        title="요청 헤더"
        description="Cloudflare AI Gateway의 cf-aig-* 이름도 그대로 받습니다. 게이트웨이가 소비하며 공급자에게는 보내지 않습니다."
      >
        <dl className="dr-header-list">
          {requestHeaders.map((header) => (
            <div key={header.name}>
              <dt>
                <code>{header.name}</code> <span className="dr-muted">· {header.alias}</span>
              </dt>
              <dd>{header.description}</dd>
            </div>
          ))}
        </dl>
      </SectionCard>
      <SectionCard title="응답 헤더" description="클라이언트에서 경로 결정을 바로 확인할 수 있습니다.">
        <dl className="dr-header-list">
          {responseHeaders.map((header) => (
            <div key={header.name}>
              <dt>
                <code>{header.name}</code>
              </dt>
              <dd>{header.description}</dd>
            </div>
          ))}
        </dl>
      </SectionCard>
    </div>
  );
}
