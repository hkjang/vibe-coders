import { endpoints } from "./endpoints";
import { AppError, isAppError } from "./error";
import { tokenStore } from "@/shared/auth/token-store";

/** Existing server CSV format, with no automatic replay or external redirects. */
export async function readChargebackCsv(month: string, signal: AbortSignal): Promise<string> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/u.test(month))
    throw new AppError("정산 월 형식을 확인하세요.", { kind: "contract" });
  const epoch = tokenStore.getSessionEpoch();
  const timeout = AbortSignal.timeout(15_000);
  const combined = AbortSignal.any([signal, timeout]);
  const check = () => {
    if (signal.aborted || epoch !== tokenStore.getSessionEpoch())
      throw new AppError("이전 계정의 내보내기를 취소했습니다.", { kind: "aborted" });
    if (timeout.aborted) throw new AppError("내보내기 응답 시간이 초과되었습니다.", { kind: "timeout" });
  };
  check();
  const token = tokenStore.getAccessToken() || tokenStore.getLegacyToken();
  try {
    const query = new URLSearchParams({ format: "csv", month });
    const response = await fetch(`${endpoints.domains.finops.chargebackPack.path}?${query}`, {
      signal: combined,
      redirect: "error",
      credentials: "same-origin",
      headers: {
        Accept: "text/csv",
        "X-Vibe-UI": "app",
        "X-Vibe-UI-Version": __UI_VERSION__,
        "X-Vibe-Route": "finops.overview",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    check();
    const requestId = response.headers.get("X-Request-ID") ?? undefined;
    if (!response.ok)
      throw new AppError("비용 배부 CSV를 내려받지 못했습니다.", {
        kind: "http",
        status: response.status,
        requestId,
      });
    if (response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() !== "text/csv")
      throw new AppError("서버가 CSV 형식으로 응답하지 않았습니다.", { kind: "contract", requestId });
    const csv = await response.text();
    check();
    return csv;
  } catch (error) {
    check();
    if (isAppError(error)) throw error;
    throw new AppError("내보내기 서버에 연결하지 못했습니다.", { kind: "network" });
  }
}
