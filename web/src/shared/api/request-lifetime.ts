import { AppError } from "@/shared/api/error";

export function discardResponse(response: Response): void {
  if (response.body && !response.body.locked) {
    // A replaced 401 or a late custom transport must not retain its unread body.
    void response.body.cancel().catch(() => undefined);
  }
}

/** One caller deadline, covering fetch, shared-refresh waiting and body consumption. */
export class RequestLifetime {
  private readonly controller = new AbortController();
  private readonly cancelled: Promise<never>;
  private rejectCancellation!: (error: AppError) => void;
  private failure: AppError | undefined;
  private response: Response | undefined;
  private readonly deadline: number;
  private readonly timer: number;
  private readonly unsubscribe: () => void;
  private disposed = false;

  constructor(
    private readonly assertSession: () => void,
    subscribeSession: (listener: () => void) => () => void,
    timeoutMs: number,
    private readonly caller?: AbortSignal,
  ) {
    this.cancelled = new Promise<never>((_resolve, reject) => {
      this.rejectCancellation = reject;
    });
    // Cancellation may arrive between two awaited operations (or before the first).
    void this.cancelled.catch(() => undefined);
    this.deadline = Date.now() + timeoutMs;
    this.timer = window.setTimeout(this.onTimeout, timeoutMs);
    this.unsubscribe = subscribeSession(this.onSession);
    caller?.addEventListener("abort", this.onCaller, { once: true });
    if (caller?.aborted) this.onCaller();
    this.onSession();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }
  get requestId(): string | undefined {
    return this.response?.headers.get("X-Request-ID") ?? undefined;
  }

  private readonly onTimeout = (): void => {
    this.cancel(
      new AppError("API 요청 시간이 초과되었습니다.", {
        kind: "timeout",
        retryable: true,
        requestId: this.requestId,
      }),
    );
  };

  private readonly onCaller = (): void => {
    this.cancel(new AppError("API 요청이 취소되었습니다.", { kind: "aborted", requestId: this.requestId }));
  };

  private readonly onSession = (): void => {
    try {
      this.assertSession();
    } catch (error) {
      this.cancel(
        error instanceof AppError
          ? error
          : new AppError("인증 세션이 변경되었습니다.", {
              kind: "aborted",
              cause: error,
            }),
      );
    }
  };

  private cancel(error: AppError): void {
    if (this.failure || this.disposed) return;
    this.failure = error;
    this.controller.abort(error);
    if (this.response) discardResponse(this.response);
    this.rejectCancellation(error);
  }

  assertActive(): void {
    this.onSession();
    if (this.caller?.aborted) this.onCaller();
    if (Date.now() >= this.deadline) this.onTimeout();
    if (this.failure) throw this.failure;
  }

  trackResponse(response: Response): void {
    this.response = response;
    if (this.signal.aborted || this.disposed) discardResponse(response);
    this.assertActive();
  }

  async run<Value>(operation: () => Promise<Value>): Promise<Value> {
    this.assertActive();
    try {
      // Also settle promptly if an injected transport/reader ignores AbortSignal.
      // Promise.race observes late rejections without publishing their result.
      const value = await Promise.race([operation(), this.cancelled]);
      this.assertActive();
      return value;
    } catch (cause) {
      this.assertActive();
      if (cause instanceof AppError) throw cause;
      throw new AppError("게이트웨이에 연결할 수 없습니다.", {
        kind: "network",
        retryable: true,
        requestId: this.requestId,
        cause,
      });
    }
  }

  dispose(): void {
    this.disposed = true;
    window.clearTimeout(this.timer);
    this.caller?.removeEventListener("abort", this.onCaller);
    this.unsubscribe();
  }
}
