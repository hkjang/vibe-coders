import { useRef, type ComponentProps } from "react";
import { Button } from "@/shared/components/ui/Button";
import { Dialog } from "@/shared/components/ui/Dialog";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { PolicySimulationSection } from "./PolicySimulationSection";
import { usePolicyDraftAccess, type PolicyDraftAccess } from "./policy-draft-access";
import { simulationText, simulationWindows } from "./policy-simulation-state";
import { usePolicyDraft } from "./use-policy-draft";
import { policyDraftStoredName } from "./policy-draft-state";
import "./policy-draft.css";

type Props = Omit<
  ComponentProps<typeof PolicySimulationSection>,
  "applyDraft" | "draftDisabled" | "draftReason" | "draftTriggerRef"
>;
export function PolicyDraftSection(props: Props) {
  const access = usePolicyDraftAccess(props.canWrite);
  return <DraftSession key={access.sessionKey} {...props} access={access} />;
}
function DraftSession({ access, ...props }: Props & { access: PolicyDraftAccess }) {
  const operation = usePolicyDraft(access, props.window);
  const panel = useRef<HTMLDivElement | null>(null);
  const triggers = useRef(new Map<string, HTMLButtonElement>());
  const selected = useRef<string | undefined>(undefined);
  const returnFocusRef = {
    get current() {
      const trigger = selected.current === undefined ? undefined : triggers.current.get(selected.current);
      return trigger?.isConnected && !trigger.disabled ? trigger : panel.current;
    },
  };
  const text = (value: string | undefined) => simulationText(value, access.prefixes);
  const busy = operation.outcome.kind === "pending";
  const successful = operation.outcome.kind === "success";
  const failed = operation.outcome.kind === "error";
  const snapshot = operation.selection?.snapshot;
  return (
    <div ref={panel} tabIndex={-1} className="policy-draft-panel">
      <PolicySimulationSection
        {...props}
        draftDisabled={!operation.canOpen}
        draftReason={access.write.reason ?? (!operation.canOpen ? "추천 목록을 다시 확인하세요." : undefined)}
        draftTriggerRef={(id, node) => {
          if (node) triggers.current.set(id, node);
          else triggers.current.delete(id);
        }}
        applyDraft={(row, trigger) => {
          selected.current = row.id;
          operation.open(row, trigger);
        }}
      />
      <Dialog
        open={snapshot !== undefined}
        onOpenChange={(next) => {
          if (!next) operation.close();
        }}
        title="비활성 정책 초안 생성"
        description="비활성 정책을 만듭니다. 실제 적용은 별도이며 서버 설정에 따라 후속 모의 검사가 실행될 수 있습니다."
        returnFocusRef={returnFocusRef}
        footer={
          <>
            <Button variant="secondary" disabled={busy} onClick={operation.close}>
              {successful ? "닫기" : "취소"}
            </Button>
            {!successful ? (
              <Button
                variant="primary"
                disabled={!operation.canSubmit}
                aria-disabled={busy || !operation.canSubmit}
                aria-busy={busy}
                onClick={() => void operation.submit()}
              >
                {busy ? "생성 중" : failed ? "다시 초안 생성" : "초안 생성"}
              </Button>
            ) : null}
          </>
        }
      >
        {snapshot ? (
          <div className="policy-draft-review">
            <div role="region" tabIndex={0} aria-label="초안 생성 검토 읽기" className="policy-draft-note">
              검토 내용을 방향키와 PageDown으로 읽을 수 있습니다.
            </div>
            <KeyValueList
              items={[
                { label: "검토한 추천", value: text(snapshot.body.title) },
                { label: "저장될 정책 이름", value: text(policyDraftStoredName(snapshot.body.title)) },
                { label: "검토한 분석 기간", value: simulationWindows[snapshot.window] },
                {
                  label: "검토한 규칙",
                  value: (
                    <pre>
                      {text(
                        JSON.stringify(
                          { conditions: snapshot.body.conditions, actions: snapshot.body.actions },
                          null,
                          2,
                        ),
                      )}
                    </pre>
                  ),
                },
              ]}
            />
            <p className="policy-draft-note">
              시뮬레이션 실행 여부는 생성 요건이 아니며 결과가 안전성을 보장하지 않습니다. 분석 기간은 추천을
              검토한 기준이며 저장 API에는 전송하지 않습니다.
            </p>
            {!successful && operation.reason ? (
              <InlineNotice title={operation.reason}>
                원래 검토한 추천과 규칙은 그대로 유지합니다. 추천 목록과 권한을 확인한 뒤 이 고정된 규칙으로
                생성할지 다시 확인하세요.
                <Button disabled={!operation.canReview || busy} onClick={operation.rereview}>
                  원래 규칙 다시 확인
                </Button>
                <Button
                  disabled={!access.suggestionsAllowed || busy || operation.refreshState === "pending"}
                  onClick={() => void operation.refreshSuggestions()}
                >
                  목록 다시 조회
                </Button>
                {operation.refreshState === "error" ? (
                  <p>추천 목록을 갱신하지 못했습니다. 목록 다시 조회로 확인하세요.</p>
                ) : null}
              </InlineNotice>
            ) : null}
            {failed ? (
              <InlineNotice
                tone="danger"
                title={operation.outcome.kind === "error" ? text(operation.outcome.message) : ""}
              >
                {operation.outcome.kind === "error" && operation.outcome.requestId ? (
                  <p>요청 ID: {text(operation.outcome.requestId)}</p>
                ) : null}
                응답이 확인되지 않아도 생성되었을 수 있습니다. 정책 목록에서 생성 여부를 확인하세요. 다시
                생성하면 중복 초안이 만들어질 수 있으며 자동 재시도하지 않습니다.
              </InlineNotice>
            ) : null}
            {operation.outcome.kind === "success" ? (
              <InlineNotice tone="success" title="비활성 정책 초안을 생성했습니다.">
                정책 탭에서 내용을 검토한 뒤 사용 여부를 결정하세요.
                {operation.outcome.refreshFailed ? (
                  <>
                    <p>생성은 확인했지만 정책 목록을 갱신하지 못했습니다. 초안을 다시 생성하지 마세요.</p>
                    <Button disabled={!access.readAllowed} onClick={operation.retryPolicyRead}>
                      정책 목록 다시 조회
                    </Button>
                  </>
                ) : null}
              </InlineNotice>
            ) : null}
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}
