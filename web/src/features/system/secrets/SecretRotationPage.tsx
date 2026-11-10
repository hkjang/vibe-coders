import { Eye, EyeOff, KeyRound } from "lucide-react";
import { useId, useRef, useState } from "react";

import { useAuth } from "@/app/auth/AuthProvider";

import { PageHeader } from "@/shared/components/page/PageHeader";
import { FormField } from "@/shared/components/form/FormField";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { isAppError } from "@/shared/api/error";
import { Button } from "@/shared/components/ui/Button";
import { Checkbox } from "@/shared/components/ui/Checkbox";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { CopyButton } from "@/shared/components/ui/CopyButton";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { useFeatureMutationAccess } from "@/shared/feature-access/use-feature-mutation-access";
import { formatNumber } from "@/shared/utils/format";
import "./secret-rotation.css";

import {
  confirmationPhrase,
  generateGatewaySecret,
  minimumSecretLength,
  rotationRefusalMessage,
  rotationRefused,
  rotationStoreLabel,
  rotationStores,
  secretDraftError,
} from "./secret-rotation";

const routeId = "system.secrets";

const preconditions = [
  {
    id: "backup",
    label: "DB와 현재 환경 파일을 함께 백업했고, 둘을 같이 복원하는 절차를 확인했습니다.",
    description: "교체 전 데이터는 교체 전 키로만 읽을 수 있습니다.",
  },
  {
    id: "instances",
    label: "이 인스턴스를 뺀 다른 게이트웨이 인스턴스를 모두 중지했습니다.",
    description: "실행 중인 다른 인스턴스는 이전 키를 메모리에 들고 있어 저장된 값을 읽지 못합니다.",
  },
  {
    id: "traffic",
    label: "일반 요청과 설정 변경, 비밀값을 쓰는 백그라운드 작업을 멈췄습니다.",
    description: "교체 잠금은 교체 요청끼리만 막습니다. 다른 요청과의 충돌은 막지 못합니다.",
  },
  {
    id: "vault",
    label: "새 비밀키를 이 화면 밖의 안전한 저장소에 보관했습니다.",
    description: "이 화면을 벗어나면 다시 볼 수 없고, 재기동에 이 값이 필요합니다.",
  },
] as const;

type Outcome =
  { kind: "success"; rotated: Readonly<Record<string, number>> } | { kind: "unknown"; requestId?: string };

/**
 * Re-encrypts every stored secret under a new GATEWAY_SECRET, the one operation here that
 * can make all provider keys unreadable. The key lives only in this component's state: it
 * is never in the URL, the query cache or browser storage, and a sent request is never
 * retried, not even after an auth refresh.
 */
export function SecretRotationPage(): React.JSX.Element {
  const auth = useAuth();
  const hasAdminWrite = auth.mode !== "authenticated" || (auth.user?.scopes.includes("admin:write") ?? false);
  const access = useFeatureMutationAccess(
    [routeId],
    hasAdminWrite,
    "비밀키 교체에는 admin:write 권한이 필요합니다.",
  );
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [secret, setSecret] = useState("");
  const [repeated, setRepeated] = useState("");
  const [visible, setVisible] = useState(false);
  const [generated, setGenerated] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const groupId = useId();

  const draftError = secretDraftError(secret, repeated);
  const allChecked = preconditions.every((item) => checked.has(item.id));
  const ready = allChecked && draftError === undefined && access.allowed;

  const clearDraft = (): void => {
    setSecret("");
    setRepeated("");
    setVisible(false);
    setGenerated(false);
    setChecked(new Set());
  };

  const rotate = async (): Promise<void> => {
    access.assertCurrent();
    try {
      const result = await apiClient.request(endpoints.domains.system.secrets.rotate, {
        body: { new_secret: secret.trim() },
        retryUnauthorized: false,
        timeoutMs: 120_000,
        routeId,
      });
      setOutcome({ kind: "success", rotated: result.rotated });
      clearDraft();
    } catch (error) {
      if (rotationRefused(error)) throw error;
      const requestId = isAppError(error) ? error.requestId : undefined;
      setOutcome({ kind: "unknown", ...(requestId ? { requestId } : {}) });
      clearDraft();
    }
  };

  if (outcome?.kind === "success") {
    const stores = [...new Set([...rotationStores, ...Object.keys(outcome.rotated)])];
    return (
      <div className="page-stack secret-rotation">
        <PageHeader
          title="비밀키 교체"
          description="저장된 모든 비밀값을 새 GATEWAY_SECRET으로 다시 암호화합니다. 점검 시간에 한 인스턴스에서만 실행합니다."
        />

        <InlineNotice tone="success" title="저장된 비밀값을 새 키로 다시 암호화했습니다.">
          이 인스턴스는 이미 새 키를 쓰고 있습니다. 아직 끝난 것은 아닙니다. 아래 순서를 마쳐야 재기동 후에도
          값을 읽을 수 있습니다.
        </InlineNotice>
        <SectionCard title="교체된 항목" description="키가 들어 있는 저장소별로 다시 암호화한 행 수입니다.">
          <div className="data-table-scroll" tabIndex={0} aria-label="교체된 항목 표 영역">
            <table className="data-table">
              <caption className="sr-only">저장소별로 다시 암호화한 행 수</caption>
              <thead>
                <tr>
                  <th scope="col">항목</th>
                  <th scope="col">행 수</th>
                </tr>
              </thead>
              <tbody>
                {stores.map((store) => (
                  <tr key={store}>
                    <th scope="row">{rotationStoreLabel(store)}</th>
                    <td className="cell-number">{formatNumber(outcome.rotated[store] ?? 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
        <SectionCard title="이제 해야 할 일">
          <ol className="secret-steps">
            <li>모든 인스턴스의 환경 파일에서 GATEWAY_SECRET을 새 키로 바꿉니다.</li>
            <li>
              모든 인스턴스를 재기동합니다. 환경 파일을 바꾸지 않고 재기동하면 저장된 값을 읽지 못합니다.
            </li>
            <li>공급자 호출, MCP, Text2SQL, SSO 로그인이 되는지 확인한 뒤 일반 요청을 다시 받습니다.</li>
          </ol>
        </SectionCard>
        <div>
          <Button onClick={() => setOutcome(undefined)}>처음 화면으로</Button>
        </div>
      </div>
    );
  }

  if (outcome?.kind === "unknown") {
    return (
      <div className="page-stack secret-rotation">
        <PageHeader
          title="비밀키 교체"
          description="저장된 모든 비밀값을 새 GATEWAY_SECRET으로 다시 암호화합니다. 점검 시간에 한 인스턴스에서만 실행합니다."
        />

        <InlineNotice tone="danger" title="교체 결과를 확인할 수 없습니다. 다시 실행하지 마세요.">
          응답을 받지 못했거나 서버가 결과를 확정하지 못했습니다. 저장된 값이 새 키로 바뀌었을 수도 있습니다.
          {outcome.requestId ? <span className="request-id"> 요청 ID: {outcome.requestId}</span> : null}
        </InlineNotice>
        <SectionCard title="결과 확인 순서">
          <ol className="secret-steps">
            <li>트래픽을 멈춘 상태를 유지하고, 이전 키와 새 키를 모두 보관합니다.</li>
            <li>
              변경 이력에서 secrets.rotate 기록을 찾습니다. 기록이 없다는 것만으로 실패라고 판단하지 않습니다.
            </li>
            <li>격리한 DB 사본을 두 키로 복호화해 어느 키가 맞는지 확인합니다.</li>
            <li>복구가 필요하면 교체 전 DB와 환경 파일을 함께 복원합니다.</li>
          </ol>
        </SectionCard>
        <div>
          <Button onClick={() => setOutcome(undefined)}>확인했습니다</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="page-stack secret-rotation">
      <PageHeader
        title="비밀키 교체"
        description="저장된 모든 비밀값을 새 GATEWAY_SECRET으로 다시 암호화합니다. 점검 시간에 한 인스턴스에서만 실행합니다."
      />

      <InlineNotice tone="warning" title="게이트웨이 전체의 비밀값을 다시 암호화하는 작업입니다.">
        공급자 API 키, MCP 인증값, Text2SQL 연결 문자열, 비밀 관리자 설정, SSO 클라이언트 비밀값이 대상입니다.
        사용자 API 키를 교체하는 작업과 다르며, 무중단으로 진행되지 않습니다.
      </InlineNotice>
      {access.allowed ? null : (
        <InlineNotice tone="warning" title="이 화면에서는 실행할 수 없습니다.">
          {access.reason}
        </InlineNotice>
      )}

      <SectionCard title="1. 사전 점검" description="네 가지를 모두 마친 뒤에만 실행할 수 있습니다.">
        <div className="secret-checklist" role="group" aria-labelledby={groupId}>
          <span id={groupId} className="sr-only">
            비밀키 교체 사전 점검
          </span>
          {preconditions.map((item) => (
            <Checkbox
              key={item.id}
              label={item.label}
              description={item.description}
              checked={checked.has(item.id)}
              onChange={(event) => {
                const next = new Set(checked);
                if (event.target.checked) next.add(item.id);
                else next.delete(item.id);
                setChecked(next);
              }}
            />
          ))}
        </div>
      </SectionCard>

      <SectionCard
        title="2. 새 비밀키"
        description={`${minimumSecretLength}자 이상이어야 합니다. 직접 입력하거나 무작위 값을 만든 뒤, 보관한 값을 다시 입력해 확인합니다.`}
        actions={
          <>
            <Button
              size="small"
              onClick={() => {
                setSecret(generateGatewaySecret());
                setRepeated("");
                setGenerated(true);
                setVisible(true);
              }}
            >
              <KeyRound aria-hidden="true" /> 무작위 값 만들기
            </Button>
            <Button size="small" onClick={() => setVisible((current) => !current)} aria-pressed={visible}>
              {visible ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}{" "}
              {visible ? "숨기기" : "보기"}
            </Button>
          </>
        }
      >
        <FormField
          label="새 비밀키"
          required
          description={
            generated ? "복사해서 안전한 저장소에 보관한 뒤, 아래에 붙여넣어 확인하세요." : undefined
          }
        >
          {(control) => (
            <div className="secret-row">
              <Input
                {...control}
                type={visible ? "text" : "password"}
                autoComplete="new-password"
                spellCheck={false}
                value={secret}
                onChange={(event) => {
                  setSecret(event.target.value);
                  setGenerated(false);
                }}
              />
              {generated ? <CopyButton label="새 비밀키 복사" size="icon" value={secret} /> : null}
            </div>
          )}
        </FormField>
        <FormField label="새 비밀키 확인" required>
          {(control) => (
            <Input
              {...control}
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              value={repeated}
              onChange={(event) => setRepeated(event.target.value)}
            />
          )}
        </FormField>
        {secret !== "" || repeated !== "" ? (
          <p className="obs-meta" role="status">
            {draftError ?? "두 입력이 일치합니다."}
          </p>
        ) : null}
      </SectionCard>

      <SectionCard title="3. 실행" description="한 번만 전송합니다. 실패해도 자동으로 다시 보내지 않습니다.">
        <div>
          <Button
            ref={triggerRef}
            variant="danger"
            disabled={!ready}
            title={access.reason}
            onClick={() => setConfirming(true)}
          >
            비밀키 교체 실행
          </Button>
        </div>
      </SectionCard>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        returnFocusRef={triggerRef}
        tone="danger"
        title="게이트웨이 비밀키를 교체할까요?"
        description="저장된 모든 비밀값을 새 키로 다시 암호화하고, 이 인스턴스는 바로 새 키를 씁니다. 응답을 기다리는 동안 이 화면을 벗어나지 마세요."
        confirmLabel="교체 실행"
        confirmDisabled={!ready}
        requireTarget={confirmationPhrase}
        errorFormatter={rotationRefusalMessage}
        onConfirm={rotate}
      />
    </div>
  );
}
