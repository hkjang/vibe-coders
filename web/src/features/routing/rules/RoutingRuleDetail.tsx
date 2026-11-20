import { routingRuleLegacyHandoff } from "./legacy-routing-handoff";
import { RoutingRuleDetailData } from "./RoutingRuleDetailData";
import type { RefObject } from "react";
import { useAuth } from "@/app/auth/AuthProvider";
import { versionAtLeast } from "@/config/migration-registry";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { FeatureLegacyLink } from "@/shared/components/ui/FeatureLegacyLink";
import { Sheet } from "@/shared/components/ui/Sheet";
import type { FeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";
import { canOpenLegacyAdmin } from "@/shared/permissions/legacy-admin";
import { validRoutingRuleDetailId } from "./routing-rule-detail-model";
export function RoutingRuleDetail({
  values,
  owner,
  onClose,
  returnFocusRef,
}: {
  values: readonly string[];
  owner: FeatureReadOwner;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}) {
  const auth = useAuth();
  const id = values[0] ?? "";
  const valid = values.length === 1 && validRoutingRuleDetailId(id, auth.credentialPrefixes);
  const supported = versionAtLeast(auth.backendVersion, "v0.86.103");
  const readable = owner.readable && !owner.denied;
  const handoff = routingRuleLegacyHandoff(
    auth.features.find((feature) => feature.featureId === "routing.rules")?.legacyPath,
    valid && supported && readable ? id : undefined,
    auth.capabilities?.legacy_routing_rule_detail === true,
    auth.credentialPrefixes,
  );
  return (
    <Sheet
      open
      title="라우팅 규칙 상세"
      description="현재 저장된 규칙을 조회합니다. 실제 요청의 선택 결과는 라우팅 미리보기에서 확인할 수 있습니다."
      scrollLabel="라우팅 규칙 정보"
      returnFocusRef={returnFocusRef}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      footer={
        <>
          {canOpenLegacyAdmin(auth) && handoff.href ? (
            <FeatureLegacyLink
              featureId="routing.rules"
              className="button button-secondary button-default"
              href={handoff.href}
            >
              {handoff.sameRule ? "기존 화면에서 같은 규칙 열기" : "기존 라우팅 화면"}
            </FeatureLegacyLink>
          ) : null}
          <Button onClick={onClose}>닫기</Button>
        </>
      }
    >
      {!valid ? (
        <InlineNotice tone="danger" title="라우팅 규칙 상세 주소를 확인하세요.">
          안전한 규칙 ID를 하나만 지정해야 합니다. 목록에서 규칙을 선택하세요.
        </InlineNotice>
      ) : null}
      {valid && !supported ? (
        <InlineNotice tone="info" title="서버 업데이트가 필요합니다.">
          정확한 상세 조회는 v0.86.103 이상 서버에서 지원합니다.
        </InlineNotice>
      ) : null}
      {valid && supported && !readable ? (
        <InlineNotice
          tone="warning"
          title="라우팅 규칙 조회 권한을 확인하세요."
          actions={
            owner.readable && owner.denied ? (
              <Button onClick={owner.restart}>권한 다시 확인</Button>
            ) : undefined
          }
        >
          routing:read 권한과 현재 기능 접근 권한이 필요합니다.
        </InlineNotice>
      ) : null}
      {valid && supported && readable ? <RoutingRuleDetailData id={id} owner={owner} /> : null}
    </Sheet>
  );
}
