import { Eraser, Play, ScanSearch } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { DLPDecision, DLPTestResult } from "@/shared/api/domains/security-dlp";
import { FormField } from "@/shared/components/form/FormField";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { CopyButton } from "@/shared/components/ui/CopyButton";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Textarea } from "@/shared/components/ui/Textarea";
import { formatNumber } from "@/shared/utils/format";

import type { DLPEditorProps } from "./DLPPage";
import {
  actionLabels,
  actionTones,
  checkLabels,
  confidenceLabels,
  dlpSamples,
  formatBytes,
  highlightParts,
  profileName,
  utf8Bytes,
} from "./dlp-model";
import { useDLPTest } from "./use-dlp";

export function DLPTestTab({
  settings,
  draft,
  dirty,
  canWrite,
  seed,
}: DLPEditorProps & {
  dirty: boolean;
  /** Text another tab sent here ("시험" on a profile entry), checked right away. */
  seed?: { text: string; id: number };
}): React.JSX.Element {
  const test = useDLPTest();
  const [text, setText] = useState(seed?.text ?? "");
  const [teamId, setTeamId] = useState("");
  const [apiKeyId, setApiKeyId] = useState("");
  const [result, setResult] = useState<{ text: string; data: DLPTestResult } | null>(null);

  const run = (value: string = text): void => {
    const submitted = value;
    if (submitted.trim() === "" || test.isPending) return;
    test.mutate(
      {
        text: submitted,
        // Only someone who may save a configuration may test an unsaved one: a draft can
        // carry many custom patterns, so the server reserves it for admin:write.
        config: canWrite ? draft : undefined,
        teamId: teamId.trim(),
        apiKeyId: apiKeyId.trim(),
      },
      { onSuccess: (data) => setResult({ text: submitted, data }) },
    );
  };

  const seededRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!seed || seededRef.current === seed.id) return;
    seededRef.current = seed.id;
    run(seed.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once per seed
  }, [seed?.id]);
  const bytes = utf8Bytes(text);
  const overLimit = bytes > draft.max_scan_bytes;

  return (
    <>
      <SectionCard
        title="테스트 스캔"
        description="텍스트를 넣으면 프로필이 무엇을 찾는지, 정책이 요청과 응답에서 각각 어떻게 처리할지 보여 줍니다. 입력한 텍스트와 결과는 저장하지 않습니다."
        actions={
          dirty ? (
            <Badge tone="warning">저장 전 초안 기준</Badge>
          ) : (
            <Badge tone="muted">저장된 설정 기준</Badge>
          )
        }
      >
        <div className="dlp-samples" role="group" aria-label="가상 예시 넣기">
          <span className="dlp-muted">가상 예시:</span>
          {dlpSamples.map((sample) => (
            <Button key={sample.id} size="small" variant="ghost" onClick={() => setText(sample.text)}>
              {sample.label}
            </Button>
          ))}
        </div>
        <form
          className="dlp-test-form"
          onSubmit={(event) => {
            event.preventDefault();
            run();
          }}
        >
          <FormField
            label="검사할 텍스트"
            description="실제 고객 정보 대신 가상 예시나 형식만 맞춘 값을 쓰세요."
          >
            {(control) => (
              <Textarea
                {...control}
                rows={6}
                value={text}
                spellCheck={false}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                  // Ctrl+Enter (⌘+Enter) scans without leaving the keyboard.
                  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                    event.preventDefault();
                    run();
                  }
                }}
              />
            )}
          </FormField>
          <div className="dlp-form-grid">
            <FormField label="팀 ID (선택)" description="팀을 지정한 정책을 확인할 때 넣습니다.">
              {(control) => (
                <Input
                  {...control}
                  value={teamId}
                  spellCheck={false}
                  onChange={(event) => setTeamId(event.target.value)}
                />
              )}
            </FormField>
            <FormField label="API 키 ID (선택)" description="키를 지정한 정책을 확인할 때 넣습니다.">
              {(control) => (
                <Input
                  {...control}
                  value={apiKeyId}
                  spellCheck={false}
                  onChange={(event) => setApiKeyId(event.target.value)}
                />
              )}
            </FormField>
          </div>
          <div className="dlp-test-actions">
            <Button type="submit" variant="primary" disabled={text.trim() === "" || test.isPending}>
              <Play aria-hidden="true" /> {test.isPending ? "검사 중…" : "검사"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={text === "" && result === null}
              onClick={() => {
                setText("");
                setResult(null);
              }}
            >
              <Eraser aria-hidden="true" /> 지우기
            </Button>
            <span className="dlp-muted" data-tone={overLimit ? "warning" : undefined} aria-live="polite">
              {formatBytes(bytes)} / 검사 상한 {formatBytes(draft.max_scan_bytes)}
              {overLimit
                ? draft.oversize === "block"
                  ? " · 실제 요청이면 차단됩니다"
                  : " · 끝부분만 검사됩니다"
                : ""}
            </span>
            <kbd className="dlp-kbd" title="검사 단축키">
              Ctrl+Enter
            </kbd>
            {!draft.enabled ? (
              <span className="dlp-muted">DLP가 꺼져 있어도 켜졌을 때의 결과를 보여 줍니다.</span>
            ) : null}
          </div>
        </form>
      </SectionCard>

      {result ? (
        <DLPTestResultView text={result.text} result={result.data} settings={settings} draft={draft} />
      ) : (
        <SectionCard title="결과">
          <EmptyState
            icon={<ScanSearch aria-hidden="true" />}
            title="아직 검사하지 않았습니다."
            description="가상 예시를 하나 골라 검사해 보세요. 찾은 위치가 텍스트 위에 표시됩니다."
          />
        </SectionCard>
      )}
    </>
  );
}

function DecisionCard({ label, decision }: { label: string; decision: DLPDecision }): React.JSX.Element {
  const action = decision.action;
  return (
    <article className="dlp-decision" data-action={action || "NONE"}>
      <h3>{label}</h3>
      <p className="dlp-decision-action">
        {action ? (
          <Badge tone={actionTones[action]}>{actionLabels[action]}</Badge>
        ) : (
          <Badge tone="success">통과</Badge>
        )}
      </p>
      {decision.policies.length > 0 ? (
        <ul className="dlp-plain-list">
          {decision.policies.map((policy) => (
            <li key={policy.policy_id}>
              <code>{policy.policy_id}</code> · {actionLabels[policy.action]}
            </li>
          ))}
        </ul>
      ) : (
        <p className="dlp-muted">걸린 정책 없음</p>
      )}
    </article>
  );
}

function DLPTestResultView({
  text,
  result,
  settings,
  draft,
}: {
  text: string;
  result: DLPTestResult;
  settings: DLPEditorProps["settings"];
  draft: DLPEditorProps["draft"];
}): React.JSX.Element {
  const parts = highlightParts(text, result.matches);
  return (
    <>
      <SectionCard
        title="판정"
        description={`${formatBytes(result.scanned_bytes)} 검사 · 일치 ${formatNumber(result.matches.length)}건 · 걸린 프로필 ${formatNumber(result.profiles.length)}개`}
      >
        {result.truncated ? (
          <InlineNotice tone="warning" title="검사 상한을 넘었습니다.">
            끝에서 {formatBytes(result.scanned_bytes)}만 검사했습니다. 상한 초과 처리가 차단이면 실제 요청은
            거부됩니다.
          </InlineNotice>
        ) : null}
        <div className="dlp-decisions">
          <DecisionCard label={`${checkLabels.REQUEST}에서`} decision={result.request} />
          <DecisionCard label={`${checkLabels.RESPONSE}에서`} decision={result.response} />
        </div>
      </SectionCard>

      <SectionCard title="찾은 위치" description="표시된 부분 위에 포인터를 올리면 항목과 신뢰도가 보입니다.">
        {result.matches.length === 0 ? (
          <p className="dlp-muted">찾은 값이 없습니다.</p>
        ) : (
          <p className="dlp-highlight" aria-label="찾은 위치가 표시된 텍스트">
            {parts.map((part, index) =>
              part.match ? (
                <mark
                  key={index}
                  title={`${part.match.entry} · ${profileName(part.match.profile, settings.catalog, draft)} · 신뢰도 ${confidenceLabels[part.match.confidence as keyof typeof confidenceLabels] ?? part.match.confidence}`}
                >
                  {part.text}
                  <span className="dlp-mark-label">{part.match.entry}</span>
                </mark>
              ) : (
                <span key={index}>{part.text}</span>
              ),
            )}
          </p>
        )}
        {result.profiles.length > 0 ? (
          <div className="data-table-scroll" tabIndex={0} aria-label="걸린 프로필 표 영역">
            <table className="data-table">
              <caption className="sr-only">걸린 프로필</caption>
              <thead>
                <tr>
                  <th scope="col">프로필</th>
                  <th scope="col">일치</th>
                  <th scope="col">항목</th>
                </tr>
              </thead>
              <tbody>
                {result.profiles.map((profile) => (
                  <tr key={profile.profile_id}>
                    <th scope="row">
                      {profile.name || profileName(profile.profile_id, settings.catalog, draft)}
                    </th>
                    <td>{formatNumber(profile.match_count)}</td>
                    <td>
                      {[
                        ...new Set(
                          result.matches
                            .filter((m) => m.profile_id === profile.profile_id)
                            .map((m) => m.entry_name),
                        ),
                      ].join(", ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </SectionCard>

      {result.request.action === "MASK" ? (
        <SectionCard title="공급자가 받을 요청" description="마스킹 정책이 적용된 뒤의 텍스트입니다.">
          <pre className="dlp-pre">{result.masked_request}</pre>
        </SectionCard>
      ) : null}

      {result.header ? (
        <SectionCard
          title="응답 헤더"
          description={`${settings.response_header}와 ${settings.compat_header}에 같은 값이 실립니다. 값 자체는 들어가지 않습니다.`}
          actions={<CopyButton value={result.header} label="헤더 값 복사" />}
        >
          <p className="dlp-header-summary">{headerSummary(result.header)}</p>
          <details className="dlp-entries">
            <summary>JSON 보기</summary>
            <pre className="dlp-pre">{prettyJSON(result.header)}</pre>
          </details>
        </SectionCard>
      ) : null}
    </>
  );
}

/** One line for the header: the action and which profiles on which side. */
function headerSummary(value: string): string {
  try {
    const parsed = JSON.parse(value) as {
      action?: string;
      findings?: { check?: string; profile?: { profile_id?: string } }[];
    };
    const sides = new Map<string, string[]>();
    for (const finding of parsed.findings ?? []) {
      const side = finding.check === "RESPONSE" ? "응답" : "요청";
      const list = sides.get(side) ?? [];
      if (finding.profile?.profile_id && !list.includes(finding.profile.profile_id))
        list.push(finding.profile.profile_id);
      sides.set(side, list);
    }
    const parts = [...sides].map(([side, ids]) => `${side}: ${ids.join(", ")}`);
    return `action ${parsed.action ?? "-"} · ${parts.join(" · ") || "findings 없음"}`;
  } catch {
    return value;
  }
}

function prettyJSON(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}
