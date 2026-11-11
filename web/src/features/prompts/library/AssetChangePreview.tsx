import { useWatch, type UseFormReturn } from "react-hook-form";
import type { PromptAsset } from "@/shared/api/domains/prompts";
import { useAuth } from "@/app/auth/AuthProvider";
import { containsPotentialSecret } from "@/shared/security/secrets";
import { hiddenLibraryText } from "./library-model";
import { assetFormValues, emptyAssetForm, newAssetID, type AssetFormValues } from "./asset-form";

const labels = {
  name: "이름",
  category: "분류",
  description: "설명",
  body: "본문",
  tags: "태그",
  note: "노트",
} as const;
export function AssetChangePreview({
  form,
  asset,
}: {
  form: UseFormReturn<AssetFormValues, unknown, AssetFormValues>;
  asset?: PromptAsset;
}) {
  const { credentialPrefixes } = useAuth();
  const watched = useWatch({ control: form.control });
  const values = { ...emptyAssetForm, ...watched };
  const before = asset ? assetFormValues(asset) : emptyAssetForm;
  const changed = (Object.keys(labels) as (keyof typeof labels)[]).filter(
    (key) => values[key] !== before[key],
  );
  const text = (value: string) =>
    containsPotentialSecret(value, credentialPrefixes) ? hiddenLibraryText : value || "(비어 있음)";
  return (
    <section aria-label="저장 전 변경 내용" className="page-stack">
      <h3>저장 전 확인</h3>
      <p className="muted">
        {asset
          ? "변경한 필드만 저장합니다. 저장 직전에 최신 자산과 비교하며, 동시 변경을 완전히 차단하는 기능은 아닙니다."
          : `새 자산 ID: ${newAssetID(values) || "영문 ID를 입력하세요"}. 기존 ID가 있으면 생성을 중단합니다.`}
      </p>
      {changed.length ? (
        changed.map((key) => (
          <details key={key}>
            <summary>{labels[key]} 변경</summary>
            <div className="prompt-change-comparison">
              <div>
                <strong>변경 전</strong>
                <pre tabIndex={0} role="region" aria-label={`${labels[key]} 변경 전 내용`}>
                  {text(before[key])}
                </pre>
              </div>
              <div>
                <strong>변경 후</strong>
                <pre tabIndex={0} role="region" aria-label={`${labels[key]} 변경 후 내용`}>
                  {text(values[key])}
                </pre>
              </div>
            </div>
          </details>
        ))
      ) : (
        <p>변경한 내용이 없습니다.</p>
      )}
    </section>
  );
}
