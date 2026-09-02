import { AlertTriangle, ExternalLink, RefreshCw } from "lucide-react";
import type { ReactNode, RefObject } from "react";

import type { ModelCatalogRow } from "@/features/gateway/models/model-catalog";
import { ModelCandidateSelection } from "@/features/gateway/models/ModelCandidateSelection";
import { ModelCatalogueFailure } from "@/features/gateway/models/ModelCatalogueFailure";
import { modelStatusPresentation } from "@/features/gateway/models/model-presentation";
import { formatInteger, formatKRW, formatPercent } from "@/features/health/health-utils";
import { isAppError } from "@/shared/api/error";
import type { AdminModelPartialFailure } from "@/shared/api/schemas";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { Dialog } from "@/shared/components/ui/Dialog";

export interface ModelDetailResourceState {
  error?: unknown;
  fetching: boolean;
  hasResponse: boolean;
  pending: boolean;
  retry: () => void;
}

interface ModelCatalogueState extends ModelDetailResourceState {
  partialFailures: readonly AdminModelPartialFailure[];
  requestId: string;
}

export interface ModelDetailEnrichment {
  pricing: ModelDetailResourceState;
  quality: ModelDetailResourceState;
  tags: ModelDetailResourceState;
}

interface ModelDetailDialogProps {
  candidates: readonly ModelCatalogRow[];
  catalogue: ModelCatalogueState;
  detailSearch: (row: ModelCatalogRow) => string;
  enrichment: ModelDetailEnrichment;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  requestedModel: string;
  requestedProvider: string;
  returnFocusRef: RefObject<HTMLElement | null>;
  row?: ModelCatalogRow;
  showLegacyAdmin: boolean;
}

function DetailResourceState({
  children,
  label,
  state,
}: {
  children: ReactNode;
  label: string;
  state: ModelDetailResourceState;
}): React.JSX.Element {
  const requestId = isAppError(state.error) ? state.error.requestId : undefined;
  const showBody = state.hasResponse || (!state.pending && !state.error);
  return (
    <div className="model-detail-resource">
      {state.pending && !state.hasResponse ? (
        <div className="model-detail-query-state" role="status">
          {label} 정보를 불러오는 중입니다.
        </div>
      ) : null}
      {state.error ? (
        <div className="model-detail-query-state model-detail-query-warning" role="alert">
          <AlertTriangle aria-hidden="true" />
          <div>
            <strong>
              {label}{" "}
              {state.hasResponse ? "갱신에 실패해 마지막 정상 데이터를 표시합니다." : "조회에 실패했습니다."}
            </strong>
            <p>{isAppError(state.error) ? state.error.message : "잠시 후 다시 시도해 주세요."}</p>
            {requestId ? <code>Request ID: {requestId}</code> : null}
          </div>
          <Button
            size="small"
            variant="secondary"
            onClick={state.retry}
            disabled={state.fetching}
            aria-label={`${label} 상세 재시도`}
          >
            <RefreshCw aria-hidden="true" /> {state.fetching ? "갱신 중" : "재시도"}
          </Button>
        </div>
      ) : null}
      {!state.error && state.fetching && state.hasResponse ? (
        <div className="model-detail-query-state" role="status">
          {label} 정보를 갱신하고 있습니다.
        </div>
      ) : null}
      {showBody ? children : null}
    </div>
  );
}

function formatDate(value: string | number | null): string {
  if (value === null) return "정보 없음";
  const timestamp = typeof value === "number" ? value * 1_000 : Date.parse(value);
  if (Number.isNaN(timestamp)) return String(value);
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "medium" }).format(timestamp);
}

function QualityDetails({ row }: { row: ModelCatalogRow }): React.JSX.Element {
  const quality = row.quality;
  if (!quality) return <p className="model-detail-empty">선택 기간의 품질 측정값이 없습니다.</p>;
  return (
    <div className="model-detail-stack-small">
      <dl className="model-detail-grid">
        <div>
          <dt>종합 품질</dt>
          <dd>{formatInteger(quality.quality_score)}점</dd>
        </div>
        <div>
          <dt>요청 성공률</dt>
          <dd>{formatPercent(quality.success_rate)}</dd>
        </div>
        <div>
          <dt>Golden Prompt</dt>
          <dd>
            {formatPercent(quality.golden_pass_rate)} · {formatInteger(quality.golden_samples)}건
          </dd>
        </div>
        <div>
          <dt>Evaluation</dt>
          <dd>
            {formatPercent(quality.eval_pass_rate)} · {formatInteger(quality.eval_samples)}건
          </dd>
        </div>
      </dl>
      {Object.keys(quality.categories).length > 0 ? (
        <ul className="model-category-list" aria-label="Evaluation 카테고리">
          {Object.entries(quality.categories).map(([category, score]) => (
            <li key={category}>
              <span>{category}</span>
              <strong>{formatPercent(score.pass_rate)}</strong>
              <small>{formatInteger(score.samples)}건</small>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function PricingDetails({ row }: { row: ModelCatalogRow }): React.JSX.Element {
  if (!row.price) return <p className="model-detail-empty">이 Model에 적용된 가격이 없습니다.</p>;
  return (
    <dl className="model-detail-grid model-price-grid">
      <div>
        <dt>Input / 1M tokens</dt>
        <dd>{formatKRW(row.price.input_krw_per_1m)}</dd>
      </div>
      <div>
        <dt>Output / 1M tokens</dt>
        <dd>{formatKRW(row.price.output_krw_per_1m)}</dd>
      </div>
      <div>
        <dt>Cached Input / 1M</dt>
        <dd>{formatKRW(row.price.cached_input_krw_per_1m)}</dd>
      </div>
    </dl>
  );
}

function DeprecationDetails({ row }: { row: ModelCatalogRow }): React.JSX.Element | null {
  const deprecation = row.model.deprecation;
  if (!deprecation && !row.model.shadowed && !row.model.shadowed_by) return null;
  return (
    <section className="model-detail-section model-deprecation" aria-labelledby="model-deprecation-title">
      <h3 id="model-deprecation-title">수명 주기 안내</h3>
      {deprecation ? (
        <dl className="model-detail-grid">
          <div>
            <dt>Action</dt>
            <dd>{deprecation.action}</dd>
          </div>
          <div>
            <dt>Sunset</dt>
            <dd>{deprecation.sunset_date || "미정"}</dd>
          </div>
          <div className="model-detail-wide">
            <dt>Replacement</dt>
            <dd>{deprecation.replacement || "지정되지 않음"}</dd>
          </div>
          {deprecation.message ? (
            <div className="model-detail-wide">
              <dt>안내</dt>
              <dd>{deprecation.message}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}
      {row.model.shadowed || row.model.shadowed_by ? (
        <p className="model-detail-note">
          {row.model.shadowed_by
            ? `Agent Route “${row.model.shadowed_by}”가 동일 Model ID를 우선 처리합니다.`
            : "다른 Agent Route가 동일 Model ID를 우선 처리합니다."}
        </p>
      ) : null}
    </section>
  );
}

export function ModelDetailDialog({
  candidates,
  catalogue,
  detailSearch,
  enrichment,
  onOpenChange,
  open,
  requestedModel,
  requestedProvider,
  returnFocusRef,
  row,
  showLegacyAdmin,
}: ModelDetailDialogProps): React.JSX.Element {
  const requestId = isAppError(catalogue.error) ? catalogue.error.requestId : undefined;
  const catalogueRequestId = requestId || catalogue.requestId;
  const failureProviderRef = row?.model.provider_ref ?? requestedProvider;
  const relevantFailures = catalogue.partialFailures.filter(
    (failure) =>
      failureProviderRef === "" ||
      failure.provider_ref === failureProviderRef ||
      failure.code === "models_provider_limit_exceeded" ||
      failure.code === "models_response_limit_exceeded",
  );
  const footer = showLegacyAdmin ? (
    <a className="button button-secondary button-default" href="/admin#/model-contracts">
      Legacy Model 계약 열기 <ExternalLink aria-hidden="true" />
    </a>
  ) : undefined;
  const status = row ? modelStatusPresentation[row.status] : undefined;

  return (
    <Dialog
      description={
        row
          ? `${row.providerLabel} Provider의 품질, 가격, 사용 지침을 읽기 전용으로 확인합니다.`
          : "Model 품질, 가격과 사용 지침을 읽기 전용으로 확인합니다."
      }
      footer={footer}
      onOpenChange={onOpenChange}
      open={open}
      returnFocusRef={returnFocusRef}
      title={row?.model.id ?? (requestedModel || "Model 상세")}
    >
      {catalogue.pending && !catalogue.hasResponse ? (
        <div className="model-detail-loading" role="status">
          상세 정보를 불러오는 중입니다.
        </div>
      ) : catalogue.error && !row ? (
        <div className="model-detail-error" role="alert">
          <AlertTriangle aria-hidden="true" />
          <div>
            <strong>Model 상세를 불러오지 못했습니다.</strong>
            <p>{isAppError(catalogue.error) ? catalogue.error.message : "잠시 후 다시 시도해 주세요."}</p>
            {requestId ? <code>Request ID: {requestId}</code> : null}
          </div>
          <Button size="small" variant="secondary" onClick={catalogue.retry} disabled={catalogue.fetching}>
            <RefreshCw aria-hidden="true" /> {catalogue.fetching ? "갱신 중" : "재시도"}
          </Button>
        </div>
      ) : !row && candidates.length > 1 ? (
        <ModelCandidateSelection candidates={candidates} detailSearch={detailSearch} />
      ) : !row && relevantFailures.length > 0 ? (
        <ModelCatalogueFailure
          failures={relevantFailures}
          fetching={catalogue.fetching}
          onRetry={catalogue.retry}
          requestId={catalogueRequestId}
          stale={false}
        />
      ) : !row ? (
        <div className="model-detail-error" role="alert">
          <AlertTriangle aria-hidden="true" />
          <div>
            <strong>Model을 찾을 수 없습니다.</strong>
            <p>요청한 “{requestedModel}” 항목이 현재 목록에 없습니다.</p>
          </div>
        </div>
      ) : (
        <DetailResourceState label="Model 카탈로그" state={catalogue}>
          <div className="model-detail-stack">
            <div className="model-detail-badges">
              <Badge tone={status?.tone}>{status?.label}</Badge>
              {row.model.stale && row.status !== "stale" ? (
                <Badge tone="warning">마지막 정상 카탈로그</Badge>
              ) : null}
              <Badge tone="info">{row.providerLabel}</Badge>
              <Badge tone={row.model.source === "live" ? "success" : "muted"}>
                {row.model.source.replace("_", " ")}
              </Badge>
            </div>

            {row.model.stale && !catalogue.error ? (
              <ModelCatalogueFailure
                failures={relevantFailures}
                fetching={catalogue.fetching}
                onRetry={catalogue.retry}
                requestId={catalogueRequestId}
                stale
              />
            ) : null}

            <section className="model-detail-section" aria-labelledby="model-identity-title">
              <h3 id="model-identity-title">Catalogue</h3>
              <dl className="model-detail-grid">
                <div>
                  <dt>Provider</dt>
                  <dd>{row.providerLabel}</dd>
                </div>
                <div>
                  <dt>Owned by</dt>
                  <dd>{row.model.owned_by || "정보 없음"}</dd>
                </div>
                <div>
                  <dt>Object</dt>
                  <dd>{row.model.object || "정보 없음"}</dd>
                </div>
                <div>
                  <dt>Provider 상태</dt>
                  <dd>{row.provider?.status ?? "정보 없음"}</dd>
                </div>
                <div>
                  <dt>Created</dt>
                  <dd>{formatDate(row.model.created)}</dd>
                </div>
                <div>
                  <dt>Fetched</dt>
                  <dd>{formatDate(row.model.fetched_at)}</dd>
                </div>
              </dl>
              {row.model.stale ? (
                <p className="model-detail-note">
                  마지막 정상 카탈로그 데이터입니다. Fetched {formatDate(row.model.fetched_at)}
                </p>
              ) : null}
            </section>

            <section className="model-detail-section" aria-labelledby="model-quality-title">
              <h3 id="model-quality-title">선택 기간 품질 · Model ID 집계</h3>
              <DetailResourceState label="Model 품질" state={enrichment.quality}>
                <QualityDetails row={row} />
              </DetailResourceState>
            </section>

            <section className="model-detail-section" aria-labelledby="model-pricing-title">
              <h3 id="model-pricing-title">Effective Pricing</h3>
              <DetailResourceState label="Model 가격" state={enrichment.pricing}>
                <PricingDetails row={row} />
              </DetailResourceState>
            </section>

            <section className="model-detail-section" aria-labelledby="model-guidance-title">
              <h3 id="model-guidance-title">사용 지침</h3>
              <DetailResourceState label="Model 사용 지침" state={enrichment.tags}>
                {row.tag ? (
                  <dl className="model-detail-grid">
                    <div>
                      <dt>Good for</dt>
                      <dd>{row.tag.good_for || "지정되지 않음"}</dd>
                    </div>
                    <div>
                      <dt>Avoid for</dt>
                      <dd>{row.tag.avoid_for || "지정되지 않음"}</dd>
                    </div>
                    <div className="model-detail-wide">
                      <dt>Risk note</dt>
                      <dd>{row.tag.risk_note || "등록된 위험 안내가 없습니다."}</dd>
                    </div>
                  </dl>
                ) : (
                  <p className="model-detail-empty">등록된 Model 사용 지침이 없습니다.</p>
                )}
              </DetailResourceState>
            </section>

            <DeprecationDetails row={row} />
          </div>
        </DetailResourceState>
      )}
    </Dialog>
  );
}
