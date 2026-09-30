import { vi } from "vitest";

/** Public synthetic content only; no upstream, socket, or server cancellation. */
export function controlledChatResponse(header = "public-diagnostic") {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
    cancel,
  });
  return {
    response: new Response(body, {
      headers: { "Content-Type": "text/event-stream", "X-Public-Trace": header },
    }),
    chunk(content = "", reasoning = "", total = 0) {
      controller.enqueue(
        new TextEncoder().encode(
          `data: ${JSON.stringify({
            choices: [{ delta: { content, reasoning_content: reasoning } }],
            usage: { prompt_tokens: 2, completion_tokens: total - 2, total_tokens: total },
          })}\n\n`,
        ),
      );
    },
    finish: () => controller.close(),
    fail: (cause: unknown) => controller.error(cause),
    cancel,
  };
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
