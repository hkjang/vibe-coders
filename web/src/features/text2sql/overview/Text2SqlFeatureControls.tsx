import type { Text2SQLFeatureRow } from "@/shared/api/domains/text2sql";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Switch } from "@/shared/components/ui/Switch";
import { PanelFailure } from "./text2sql-presentation";
import { featureLabel, writeDisabledTitle } from "./text2sql-labels";
import { text2sqlInvalidations, text2sqlRouteId } from "./use-text2sql-queries";
import { useText2SqlMutation } from "./use-text2sql-mutation";

interface Props {
  canWrite: boolean;
  features: readonly Text2SQLFeatureRow[];
  error: unknown;
  loading: boolean;
  onRetry: () => void;
}

export function Text2SqlFeatureControls({ canWrite, features, error, loading, onRetry }: Props) {
  const writable = canWrite && !error && !loading;
  const toggle = useText2SqlMutation({
    authorized: writable,
    mutate: (variables: { name: string; enabled: boolean }) =>
      apiClient.request(endpoints.domains.text2sql.features.toggle, {
        body: variables,
        routeId: text2sqlRouteId,
      }),
    invalidates: text2sqlInvalidations.features,
    successMessage: (_result, variables) =>
      `${featureLabel(variables.name)} 기능을 ${variables.enabled ? "켰습니다" : "껐습니다"}.`,
  });
  return (
    <SectionCard
      title="선택 기능 켜기·끄기"
      description="Text2SQL 처리 과정의 선택 기능입니다. 긴급 중지와 재개는 화면 상단에서 별도로 검토합니다."
    >
      {error ? (
        <PanelFailure error={error} hasData={features.length > 0} label="선택 기능" onRetry={onRetry} />
      ) : null}
      <ul className="t2s-toggle-list">
        {loading && features.length === 0 ? <li role="status">기능 목록을 불러오는 중입니다.</li> : null}
        {!loading && !error && features.length === 0 ? <li>사용 가능한 선택 기능이 없습니다.</li> : null}
        {features.map((feature) => (
          <li key={feature.name}>
            <div>
              <strong>{featureLabel(feature.name)}</strong>
              <p>{feature.description}</p>
            </div>
            <Switch
              checked={feature.enabled}
              disabled={!writable || toggle.isPending}
              title={
                writeDisabledTitle(canWrite) ??
                (error || loading ? "선택 기능 목록을 확인한 후 변경하세요." : undefined)
              }
              label={feature.enabled ? "켜짐" : "꺼짐"}
              aria-label={`${featureLabel(feature.name)} ${feature.enabled ? "켜짐" : "꺼짐"}`}
              onCheckedChange={(enabled) => toggle.mutate({ name: feature.name, enabled })}
            />
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}
