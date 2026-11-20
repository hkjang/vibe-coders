import { AppError } from "./error";

export interface ReadQueue {
  run<Data>(read: () => Promise<Data>, signal: AbortSignal): Promise<Data>;
}

const cancelled = () => new AppError("조회 요청이 취소되었습니다.", { kind: "aborted" });

/** A view owns its queue; authentication and mutations never wait behind these reads. */
export function createReadQueue(limit: number): ReadQueue {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("Invalid read concurrency limit");
  let active = 0;
  const waiting = new Set<() => void>();
  const drain = () => {
    while (active < limit && waiting.size) {
      const start = waiting.values().next().value;
      if (start) {
        waiting.delete(start);
        start();
      }
    }
  };
  return {
    run<Data>(read: () => Promise<Data>, signal: AbortSignal): Promise<Data> {
      if (signal.aborted) return Promise.reject(cancelled());
      return new Promise<Data>((resolve, reject) => {
        const abort = () => {
          waiting.delete(start);
          signal.removeEventListener("abort", abort);
          reject(cancelled());
        };
        const start = () => {
          signal.removeEventListener("abort", abort);
          active += 1;
          // Keep a slot until the actual read settles, including cancellation cleanup.
          void Promise.resolve()
            .then(async () => {
              if (signal.aborted) throw cancelled();
              const data = await read();
              if (signal.aborted) throw cancelled();
              return data;
            })
            .then(resolve, reject)
            .finally(() => {
              active -= 1;
              drain();
            });
        };
        waiting.add(start);
        signal.addEventListener("abort", abort, { once: true });
        drain();
      });
    },
  };
}
