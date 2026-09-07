import { redTeamImportResultSchema, type RedTeamImportResult } from "@/shared/api/domains/redteam";
import { AppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";
import { downloadCsv } from "@/shared/utils/csv";

// Probe-prompt CSV round-trips are not JSON, so they bypass `apiClient` and call
// `fetch` directly with the console's auth and UI headers.
const exportPath = "/admin/redteam/probe-packs/export?format=csv";
const importPath = "/admin/redteam/probe-packs/import";

function requestHeaders(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  const token = tokenStore.getAccessToken() || tokenStore.getLegacyToken();
  return {
    "X-Vibe-UI": "app",
    ...(token === "" ? {} : { Authorization: `Bearer ${token}` }),
    ...extra,
  };
}

function transportError(cause: unknown): AppError {
  return new AppError("게이트웨이에 연결할 수 없습니다.", { kind: "network", retryable: true, cause });
}

async function failure(response: Response, fallback: string): Promise<AppError> {
  const body = await response.text().catch(() => "");
  let message = fallback;
  try {
    const parsed: unknown = body === "" ? undefined : JSON.parse(body);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "error" in parsed &&
      typeof parsed.error === "object" &&
      parsed.error !== null &&
      "message" in parsed.error &&
      typeof parsed.error.message === "string"
    ) {
      message = parsed.error.message;
    }
  } catch {
    // Non-JSON error bodies keep the generic message; raw text may echo input.
  }
  return new AppError(message, {
    kind: response.status === 403 ? "permission" : response.status === 401 ? "auth" : "http",
    status: response.status,
    requestId: response.headers.get("X-Request-ID") ?? undefined,
  });
}

/** Downloads the full probe-prompt catalogue as CSV (Excel-friendly, server-rendered). */
export async function exportProbePrompts(): Promise<void> {
  let response: Response;
  try {
    response = await fetch(exportPath, { headers: requestHeaders() });
  } catch (cause) {
    throw transportError(cause);
  }
  if (!response.ok) throw await failure(response, "프롬프트 CSV를 내보내지 못했습니다.");
  downloadCsv("redteam-probe-prompts.csv", await response.text());
}

/** Uploads an edited probe-prompt CSV; the server upserts packs and cases by id. */
export async function importProbePrompts(csv: string): Promise<RedTeamImportResult> {
  let response: Response;
  try {
    response = await fetch(importPath, {
      method: "POST",
      headers: requestHeaders({ "Content-Type": "text/csv" }),
      body: csv,
    });
  } catch (cause) {
    throw transportError(cause);
  }
  if (!response.ok) throw await failure(response, "프롬프트 CSV를 가져오지 못했습니다.");
  const parsed = redTeamImportResultSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new AppError("API 응답 형식이 예상 계약과 다릅니다.", {
      kind: "contract",
      status: response.status,
      details: parsed.error.flatten(),
    });
  }
  return parsed.data;
}
