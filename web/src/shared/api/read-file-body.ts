import { AppError } from "@/shared/api/error";
import { discardResponse, type RequestLifetime } from "@/shared/api/request-lifetime";

interface BodyLimit {
  maxBytes?: number;
  tooLargeMessage?: string;
}

/** Enforces decoded byte limits even for chunked, compressed or dishonest responses. */
export async function readFileBody(
  response: Response,
  lifetime: RequestLifetime,
  limit: BodyLimit,
): Promise<ArrayBuffer> {
  const tooLarge = () =>
    new AppError(
      limit.tooLargeMessage ?? "내보내기 응답이 허용 크기를 초과했습니다. 잘라 내려받지 않습니다.",
      {
        kind: "contract",
        code: "response_too_large",
        status: response.status,
        requestId: response.headers.get("X-Request-ID") ?? undefined,
      },
    );
  const length = Number(response.headers.get("Content-Length"));
  if (limit.maxBytes !== undefined && length > limit.maxBytes) {
    discardResponse(response);
    throw tooLarge();
  }
  if (!response.body)
    throw new AppError("내보내기 응답 본문이 없습니다.", {
      kind: "contract",
      status: response.status,
      requestId: lifetime.requestId,
    });
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  lifetime.signal.addEventListener("abort", cancel, { once: true });
  const parts: Uint8Array[] = [];
  let total = 0;
  let completed = false;
  try {
    for (;;) {
      const next = await lifetime.run(() => reader.read());
      if (next.done) break;
      total += next.value.byteLength;
      if (limit.maxBytes !== undefined && total > limit.maxBytes) throw tooLarge();
      parts.push(next.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    lifetime.assertActive();
    completed = true;
    return bytes.buffer;
  } finally {
    if (!completed) cancel();
    lifetime.signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}
