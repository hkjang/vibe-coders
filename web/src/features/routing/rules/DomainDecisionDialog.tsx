import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Button } from "@/shared/components/ui/Button";
import { Dialog } from "@/shared/components/ui/Dialog";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { formatDateTime, formatNumber } from "@/shared/utils/format";
import type { DomainDecisionsAccess } from "./domain-decisions-access";
import type { DomainDecisionSnapshot, DomainDecisionsQuery } from "./domain-decisions-query";
import {
  domainDecisionSourceLabel,
  domainDecisionText,
  type DomainDecisionSource,
} from "./domain-decisions-state";

interface Props {
  access: DomainDecisionsAccess;
  source: DomainDecisionSource;
  snapshot: DomainDecisionSnapshot;
  query: DomainDecisionsQuery;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}
function DecisionHeading() {
  const heading = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    heading.current?.focus({ preventScroll: true });
    heading.current?.closest<HTMLElement>(".dialog-content")?.scrollTo?.({ top: 0 });
  }, []);
  return (
    <h3 tabIndex={-1} ref={heading}>
      선택한 결정 기록
    </h3>
  );
}
export function DomainDecisionDialog({ access, source, snapshot, query, onClose, returnFocusRef }: Props) {
  const signalHeading = useRef<HTMLHeadingElement>(null);
  const [signalPage, setSignalPage] = useState(0);
  const [toolPage, setToolPage] = useState(0);
  const text = (value: string) => domainDecisionText(value, access.prefixes);
  const item = source.item;
  const signalPages = Math.max(1, Math.ceil((source.signals?.length ?? 0) / 20));
  const toolPages = Math.max(1, Math.ceil(item.tool_names.length / 20));
  const changeSignalPage = (page: number) => {
    setSignalPage(page);
    signalHeading.current?.focus();
    signalHeading.current?.scrollIntoView?.({ block: "start" });
  };
  const refresh = () => {
    void query.refresh().catch(() => {});
  };
  return (
    <Dialog
      open
      title="도메인 결정 근거"
      description="선택한 결정의 기록과 함께 조회된 근거를 읽습니다. 라우팅이나 검토 상태는 바꾸지 않습니다."
      returnFocusRef={returnFocusRef}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      footer={
        <>
          <Button
            aria-disabled={query.result.isFetching}
            aria-busy={query.result.isFetching}
            onClick={refresh}
          >
            결정 목록 다시 조회
          </Button>
          <Button onClick={onClose}>닫기</Button>
        </>
      }
    >
      <div className="domain-decision-dialog">
        <DecisionHeading />
        <p>
          이 상세는 열었을 때의 내용입니다. 목록을 다시 조회해도 바뀌지 않으며, 새 내용은 창을 닫고 다시
          선택하세요.
        </p>
        <p className="routing-meta">선택한 목록 수신(한국 시각): {formatDateTime(snapshot.receivedAt)}</p>
        {!query.isCurrent(snapshot) ? (
          <InlineNotice
            tone={query.result.isError ? "danger" : "info"}
            title="이전 조회에서 선택한 기록입니다."
          >
            {query.result.isFetching
              ? "목록을 다시 조회하고 있습니다."
              : "현재 목록과 같은 조회 결과임을 확인할 수 없습니다."}
          </InlineNotice>
        ) : null}
        <dl className="domain-decision-values">
          <div>
            <dt>결정 ID</dt>
            <dd>{text(item.id)}</dd>
          </div>
          <div>
            <dt>요청 ID</dt>
            <dd>{text(item.request_id)}</dd>
          </div>
          <div>
            <dt>기록된 라우트</dt>
            <dd>{text(item.route)}</dd>
          </div>
          <div>
            <dt>신뢰도 기록값</dt>
            <dd>{formatNumber(item.confidence, 4)}</dd>
          </div>
          <div>
            <dt>증거 점수</dt>
            <dd>{formatNumber(item.evidence_score, 4)}</dd>
          </div>
          <div>
            <dt>증거 수</dt>
            <dd>{formatNumber(item.evidence_count)}</dd>
          </div>
          <div>
            <dt>후보 도구 이름</dt>
            <dd>
              {item.tool_names.length
                ? item.tool_names.slice(toolPage * 20, (toolPage + 1) * 20).map((tool, index) => (
                    <span className="domain-decision-tool" key={index}>
                      {text(tool)}
                    </span>
                  ))
                : "없음"}
              {toolPages > 1 ? (
                <nav className="domain-decision-pagination" aria-label="현재 응답의 후보 도구 페이지">
                  <Button size="small" disabled={toolPage === 0} onClick={() => setToolPage(toolPage - 1)}>
                    이전 도구 페이지
                  </Button>
                  <span aria-live="polite">
                    후보 {formatNumber(item.tool_names.length)}개 · {toolPage + 1}/{toolPages}
                  </span>
                  <Button
                    size="small"
                    disabled={toolPage >= toolPages - 1}
                    onClick={() => setToolPage(toolPage + 1)}
                  >
                    다음 도구 페이지
                  </Button>
                </nav>
              ) : null}
            </dd>
          </div>
          <div>
            <dt>기록된 대체 경로 사용</dt>
            <dd>{item.fallback_used ? "예" : "아니오"}</dd>
          </div>
          <div>
            <dt>기록된 정책 차단</dt>
            <dd>{item.blocked_by_governance ? "예" : "아니오"}</dd>
          </div>
          <div>
            <dt>결정 사유</dt>
            <dd>{text(item.reason)}</dd>
          </div>
          <div>
            <dt>기록 시각</dt>
            <dd>{text(item.created_at)}</dd>
          </div>
        </dl>
        <p className="routing-meta">
          신뢰도는 확률이 아닌 기록값이며, 후보 도구가 실제 호출되었다는 뜻은 아닙니다. 대체 경로·차단
          값만으로 실제 실행 결과를 확정할 수 없습니다.
        </p>
        <section aria-label="함께 조회된 결정 근거">
          <h3 tabIndex={-1} ref={signalHeading}>
            함께 조회된 결정 근거
          </h3>
          <p>
            결정과 근거는 별도로 조회됩니다. 표시된 순서가 실행 순서이거나 근거가 모두 수집되었다는 뜻은
            아닙니다.
          </p>
          {source.signals !== null ? (
            <p aria-live="polite">
              함께 조회된 근거 {formatNumber(source.signals.length)}건 · 현재 응답 안에서 {signalPage + 1}/
              {signalPages}페이지
            </p>
          ) : null}
          {source.signals === null ? (
            <InlineNotice tone="warning" title="근거 조회를 확인하지 못했습니다.">
              근거가 없다는 뜻은 아닙니다. 목록을 다시 조회한 뒤 이 결정을 다시 선택하세요.
            </InlineNotice>
          ) : source.signals.length === 0 ? (
            <p>현재 응답에 근거 기록이 없습니다.</p>
          ) : (
            <ol className="domain-decision-signals" start={signalPage * 20 + 1}>
              {source.signals.slice(signalPage * 20, (signalPage + 1) * 20).map((signal, index) => (
                <li key={index}>
                  <h4>{domainDecisionSourceLabel(signal.source, access.prefixes)}</h4>
                  <dl className="domain-decision-values">
                    <div>
                      <dt>근거 ID</dt>
                      <dd>{text(signal.id)}</dd>
                    </div>
                    <div>
                      <dt>연결된 결정 ID</dt>
                      <dd>{text(signal.decision_id)}</dd>
                    </div>
                    <div>
                      <dt>출처 기록값</dt>
                      <dd>{text(signal.source)}</dd>
                    </div>
                    <div>
                      <dt>기록된 라우트</dt>
                      <dd>{text(signal.route)}</dd>
                    </div>
                    <div>
                      <dt>점수</dt>
                      <dd>{formatNumber(signal.score, 4)}</dd>
                    </div>
                    <div>
                      <dt>근거 사유</dt>
                      <dd>{text(signal.reason)}</dd>
                    </div>
                    <div>
                      <dt>기록 시각</dt>
                      <dd>{text(signal.created_at)}</dd>
                    </div>
                  </dl>
                </li>
              ))}
            </ol>
          )}
          {signalPages > 1 ? (
            <nav className="domain-decision-pagination" aria-label="현재 응답의 근거 페이지">
              <Button disabled={signalPage === 0} onClick={() => changeSignalPage(signalPage - 1)}>
                이전 근거 페이지
              </Button>
              <span aria-live="polite">
                {signalPage + 1} / {signalPages}
              </span>
              <Button
                disabled={signalPage >= signalPages - 1}
                onClick={() => changeSignalPage(signalPage + 1)}
              >
                다음 근거 페이지
              </Button>
            </nav>
          ) : null}
        </section>
      </div>
    </Dialog>
  );
}
