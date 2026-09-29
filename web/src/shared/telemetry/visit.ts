import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { uiTelemetryFeatureIdSchema } from "@/shared/api/domains/ui-telemetry";

/** A fresh, memory-only identifier for one feature visit, never a user/session ID. */
function newVisitId(): string | undefined {
  try {
    return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  } catch {
    return undefined;
  }
}

export interface FeatureVisit {
  recordVisit: () => void;
  recordLegacyOpen: () => void;
}

/** No queue, storage, retry, logging, raw URL, resource ID, or page content. */
export function createFeatureVisit(featureId: string): FeatureVisit {
  const feature = uiTelemetryFeatureIdSchema.safeParse(featureId);
  const visitId = newVisitId();
  let visitSent = false;
  let legacySent = false;
  const send = (event: "visit" | "legacy_fallback"): void => {
    if (!visitId || !feature.success) return;
    void apiClient
      .request(endpoints.uiTelemetry.events, {
        body: { feature_id: feature.data, visit_id: visitId, event },
        routeId: "ui.telemetry",
        keepalive: true,
        referrerPolicy: "no-referrer",
        retryUnauthorized: false,
        timeoutMs: 2_000,
      })
      .catch(() => undefined);
  };
  return {
    recordVisit: () => {
      if (visitSent) return;
      visitSent = true;
      send("visit");
    },
    recordLegacyOpen: () => {
      if (legacySent) return;
      legacySent = true;
      send("legacy_fallback");
    },
  };
}
