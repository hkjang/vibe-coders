import { useRef, useState } from "react";
import { FormField } from "@/shared/components/form/FormField";
import { Button } from "@/shared/components/ui/Button";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Textarea } from "@/shared/components/ui/Textarea";
import { containsPotentialSecret, secretSearchMessage } from "@/shared/security/secrets";
import { formatNumber } from "@/shared/utils/format";
import { useRoutingPreviewAccess, type RoutingPreviewAccess } from "./routing-preview-access";
import { useRoutingPreviewOperation } from "./routing-preview-operation";
import "./routing-preview.css";
import {
  emptyPreviewDraft,
  previewDraftChanged,
  previewText,
  previewTier,
  type PreviewDraft,
} from "./routing-preview-state";

export function RoutingPreviewCard() {
  const access = useRoutingPreviewAccess();
  return <PreviewCard key={access.securityKey} access={access} />;
}

function PreviewCard({ access }: { access: RoutingPreviewAccess }) {
  const [draft, setDraft] = useState<PreviewDraft>(emptyPreviewDraft);
  const latestDraft = useRef(draft);
  const { state, run } = useRoutingPreviewOperation(access);
  const pending = state.kind === "pending";
  const suspicious = containsPotentialSecret(draft.apiKeyId, access.credentialPrefixes);
  const snapshot = state.kind === "idle" ? undefined : state.snapshot;
  const result = state.kind === "success" && access.readAllowed ? state.result : undefined;
  const display = (value: string | undefined, empty?: string) =>
    previewText(value, access.credentialPrefixes, empty);
  function change(field: keyof PreviewDraft, value: string) {
    const next = { ...latestDraft.current, [field]: value };
    latestDraft.current = next;
    setDraft(next);
  }
  return (
    <SectionCard
      className="routing-preview-card"
      title="라우팅 미리보기"
      description="샘플 요청을 서버로 보내 현재 설정의 예상 계획을 계산합니다. 실제 모델은 호출하지 않습니다."
      actions={
        <Button
          variant="primary"
          disabled={pending || !access.readAllowed || !draft.model.trim() || suspicious}
          onClick={() => void run(() => latestDraft.current)}
        >
          {pending ? "확인 중" : "미리보기 실행"}
        </Button>
      }
    >
      {access.reason ? (
        <InlineNotice tone="warning" title="미리보기 조회 잠김">
          {access.reason}
        </InlineNotice>
      ) : null}
      <div className="routing-form">
        <FormField label="요청 모델" required>
          {(control) => (
            <Input
              {...control}
              value={draft.model}
              placeholder="gpt-4.1"
              onChange={(event) => change("model", event.target.value)}
            />
          )}
        </FormField>
        <FormField
          label="정책 API 키 ID"
          description="비우면 키 정책 없이 계산합니다. 키 원문이 아니라 키 ID를 입력하세요."
          error={suspicious ? secretSearchMessage : undefined}
        >
          {(control) => (
            <Input
              {...control}
              value={draft.apiKeyId}
              onChange={(event) => change("apiKeyId", event.target.value)}
            />
          )}
        </FormField>
      </div>
      {suspicious ? (
        <InlineNotice tone="warning" title="키 식별자를 확인하세요.">
          키 원문으로 보이는 값은 미리보기에 전송하지 않습니다.
        </InlineNotice>
      ) : null}
      <FormField
        label="샘플 요청 내용"
        description="서버의 복잡도·위험 계산에 사용합니다. 결과에 원문을 다시 표시하지 않습니다."
      >
        {(control) => (
          <Textarea
            {...control}
            rows={3}
            value={draft.sample}
            onChange={(event) => change("sample", event.target.value)}
          />
        )}
      </FormField>
      {snapshot && access.readAllowed ? (
        <>
          <KeyValueList
            items={[
              { label: "계산한 요청 모델", value: display(snapshot.body.model), mono: true },
              {
                label: "계산한 키 정책",
                value: snapshot.body.api_key_id ? display(snapshot.body.api_key_id) : "키 정책 없음",
              },
              { label: "샘플 기준", value: "실행 당시 입력으로 계산하며 원문은 결과에 복제하지 않습니다." },
            ]}
          />
          {previewDraftChanged(draft, snapshot) ? (
            <InlineNotice tone="warning" title="입력이 달라졌습니다. 다시 미리보기로 확인하세요.">
              현재 입력은 자동으로 실행하지 않습니다. 아래 상태와 결과는 마지막으로 실행한 기준입니다.
            </InlineNotice>
          ) : null}
        </>
      ) : null}
      {pending ? (
        <InlineNotice tone="info" title="미리보기 계산 중">
          입력을 변경해도 이미 보낸 계산 기준은 바뀌지 않습니다.
        </InlineNotice>
      ) : null}
      {state.kind === "error" && access.readAllowed ? (
        <InlineNotice tone="danger" title="미리보기를 실행하지 못했습니다.">
          {state.message}
          {state.requestId ? ` 요청 ID: ${display(state.requestId)}` : ""} 다시 실행하려면 미리보기 실행을
          선택하세요.
        </InlineNotice>
      ) : null}
      {result ? (
        <>
          <InlineNotice tone="info" title="현재 설정의 예상 계획">
            실제 호출 권한·성공·장애 전환 이력이 확정된 결과는 아닙니다. 서버 설정과 상태가 바뀌면 달라질 수
            있습니다.
          </InlineNotice>
          <KeyValueList
            items={[
              { label: "요청 모델", value: display(result.requested_model), mono: true },
              { label: "선택 모델", value: display(result.selected_model), mono: true },
              { label: "선택 공급자", value: display(result.selected_provider) },
              { label: "정책 API 키", value: display(result.policy_api_key_id), mono: true },
              {
                label: "복잡도",
                value: `${formatNumber(result.complexity?.score)} (${previewTier(result.complexity?.tier, access.credentialPrefixes)})`,
              },
              {
                label: "위험",
                value: `${formatNumber(result.risk?.score)} (${previewTier(result.risk?.tier, access.credentialPrefixes)})`,
              },
              { label: "상태 점수", value: formatNumber(result.health_score) },
              { label: "라우팅 사유", value: display(result.route_reason) },
              { label: "결정 사유", value: display(result.decision_reason) },
              {
                label: "장애 전환 예상 계획",
                value: result.fallback_plan.length
                  ? result.fallback_plan.map((entry) => display(entry)).join(" → ")
                  : "—",
              },
            ]}
          />
          {result.would_rewrite ? (
            <InlineNotice tone="warning" title="요청 모델을 바꾸는 계획입니다.">
              계산 결과는 {display(result.requested_model)} 대신 {display(result.selected_model)} 선택을
              예상합니다. 실제 호출 결과는 아닙니다.
            </InlineNotice>
          ) : null}
        </>
      ) : state.kind === "idle" && access.readAllowed ? (
        <EmptyState
          title="아직 미리보기를 실행하지 않았습니다."
          description="모델 이름을 넣고 실행하면 현재 설정의 라우팅 예상 계획을 보여 줍니다."
        />
      ) : null}
    </SectionCard>
  );
}
