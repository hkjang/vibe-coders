import { AppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";
import { policyImportEndpoints } from "./policy-import";
import { importProblem, policyImportLimits } from "./policy-import-json";

/** Raw export bytes, intentionally not JSON.parse/stringify. No refresh loop. */
export async function readPolicyExport(options: {
  signal: AbortSignal;
  assertCurrent: () => void;
}): Promise<ArrayBuffer> {
  const epoch = tokenStore.getSessionEpoch();
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  const current = () => {
    if (timedOut) throw new AppError("정책 조회 시간이 초과되었습니다.", { kind: "timeout" });
    if (epoch !== tokenStore.getSessionEpoch() || options.signal.aborted)
      throw new AppError("이전 내보내기 요청입니다.", { kind: "aborted" });
    options.assertCurrent();
  };
  current();
  options.signal.addEventListener("abort", abort, { once: true });
  const timer = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 15_000);
  try {
    const token = tokenStore.getAccessToken() || tokenStore.getLegacyToken();
    const response = await fetch(policyImportEndpoints.export.path, {
      method: policyImportEndpoints.export.method,
      signal: controller.signal,
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "X-Vibe-UI": "app",
        "X-Vibe-UI-Version": __UI_VERSION__,
        "X-Vibe-Route": "governance.policies",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    current();
    if (!response.ok)
      throw new AppError(
        response.status === 401
          ? "로그인과 정책 조회 권한을 확인한 뒤 수동으로 다시 시도하세요."
          : "정책 백업을 조회하지 못했습니다.",
        {
          kind: response.status === 401 ? "auth" : "http",
          status: response.status,
          requestId: response.headers.get("X-Request-ID") ?? undefined,
        },
      );
    const tooLarge = () => {
      controller.abort();
      return importProblem(
        "내보내기 응답이 UI 한도 4 MiB를 초과했습니다. 잘라 내려받지 않습니다. 정식 운영 백업 절차를 이용하세요.",
      );
    };
    const length = response.headers.get("Content-Length");
    if (length && Number(length) > policyImportLimits.bytes) tooLarge();
    if (!response.body) throw new AppError("내보내기 응답 본문이 없습니다.", { kind: "contract" });
    const reader = response.body.getReader();
    const parts: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const next = await reader.read();
        current();
        if (next.done) break;
        total += next.value.byteLength;
        if (total > policyImportLimits.bytes) {
          void reader.cancel().catch(() => {});
          tooLarge();
        }
        parts.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      joined.set(part, offset);
      offset += part.length;
    }
    const bytes = joined.buffer;
    current();
    return bytes;
  } catch (cause) {
    current();
    if (timedOut) throw new AppError("정책 조회 시간이 초과되었습니다.", { kind: "timeout" });
    throw cause;
  } finally {
    window.clearTimeout(timer);
    options.signal.removeEventListener("abort", abort);
  }
}
