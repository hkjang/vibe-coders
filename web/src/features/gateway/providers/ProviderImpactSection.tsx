import { useId, useState } from "react";

import {
  providerImpactCount,
  providerImpactReason,
} from "@/features/gateway/providers/provider-impact-labels";
import type { ProviderImpactSection as ImpactSection } from "@/shared/api/domains/provider-impact";
import { Button } from "@/shared/components/ui/Button";
import { containsPotentialSecret } from "@/shared/security/secrets";

const pageSize = 10;

export function ProviderImpactSection({
  title,
  description,
  section,
  pending,
  credentialPrefixes,
}: {
  title: string;
  description: string;
  section?: ImpactSection;
  pending: boolean;
  credentialPrefixes?: readonly string[];
}): React.JSX.Element {
  const titleId = useId();
  const [position, setPosition] = useState({ section, page: 0 });
  const page = position.section === section ? position.page : 0;
  const items = section?.items ?? [];
  const pages = Math.ceil(items.length / pageSize);
  return (
    <section aria-labelledby={titleId} className="provider-impact-section">
      <h4 id={titleId}>{title}</h4>
      <p>{description}</p>
      <p>
        <strong>{section ? providerImpactCount(section) : "확인하지 못함"}</strong>
      </p>
      <p className="field-description">
        {section ? providerImpactReason(section) : "조회가 완료되지 않아 이 항목의 영향을 알 수 없습니다."}
        {section?.scanned_count !== null && section?.scanned_count !== undefined
          ? ` 확인한 설정 ${section.scanned_count}건.`
          : ""}
      </p>
      {items.length ? (
        <>
          <ul className="provider-impact-items">
            {items.slice(page * pageSize, (page + 1) * pageSize).map((item) => (
              <li key={item.reference}>
                <span>
                  {containsPotentialSecret(item.label, credentialPrefixes) ? "비공개 항목" : item.label}
                </span>
                <span className="field-description"> · {item.enabled ? "활성" : "비활성"}</span>
                {item.model ? (
                  <span>
                    {" "}
                    · 모델: {containsPotentialSecret(item.model, credentialPrefixes) ? "비공개" : item.model}
                  </span>
                ) : null}
                <code>{item.reference}</code>
              </li>
            ))}
          </ul>
          <p className="field-description">
            표시 항목 {items.length}건 중 {page * pageSize + 1}–
            {Math.min((page + 1) * pageSize, items.length)}건
          </p>
          {pages > 1 ? (
            <nav aria-label={`${title} 참조 페이지`} className="provider-impact-pagination">
              <Button
                size="small"
                variant="secondary"
                disabled={pending || page === 0}
                onClick={() => setPosition({ section, page: page - 1 })}
              >
                이전
              </Button>
              <span>
                {page + 1} / {pages}
              </span>
              <Button
                size="small"
                variant="secondary"
                disabled={pending || page + 1 >= pages}
                onClick={() => setPosition({ section, page: page + 1 })}
              >
                다음
              </Button>
            </nav>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
