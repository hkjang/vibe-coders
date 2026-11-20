import { expect, it, vi } from "vitest";
import { createReadQueue } from "./read-queue";

function deferred<Data>() {
  let resolve!: (value: Data) => void;
  const promise = new Promise<Data>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("지연된 조회도 동시 상한을 지키며 대기 순서대로 시작하고 각 결과를 보존한다", async () => {
  const queue = createReadQueue(3);
  const values = Array.from({ length: 8 }, () => deferred<number>());
  const started: number[] = [];
  let active = 0,
    peak = 0;
  const results = values.map((value, index) =>
    queue.run(async () => {
      started.push(index);
      peak = Math.max(peak, ++active);
      const result = await value.promise;
      active--;
      return result;
    }, new AbortController().signal),
  );
  await vi.waitFor(() => expect(started).toEqual([0, 1, 2]));
  values[1]?.resolve(101);
  await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3]));
  values[0]?.resolve(100);
  await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3, 4]));
  values.forEach((value, index) => value.resolve(100 + index));
  expect(await Promise.all(results)).toEqual([100, 101, 102, 103, 104, 105, 106, 107]);
  expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  expect(peak).toBe(3);
});

it("대기 중 취소는 즉시 끝나고 해당 API를 호출하지 않으며 다음 조회를 막지 않는다", async () => {
  const queue = createReadQueue(1),
    held = deferred<string>();
  const first = queue.run(() => held.promise, new AbortController().signal);
  const cancelled = new AbortController(),
    read = vi.fn(async () => "obsolete");
  const second = queue.run(read, cancelled.signal);
  const rejection = expect(second).rejects.toMatchObject({ kind: "aborted" });
  const last = queue.run(async () => "current", new AbortController().signal);
  cancelled.abort("untrusted cancellation detail");
  await rejection;
  expect(read).not.toHaveBeenCalled();
  held.resolve("first");
  expect(await first).toBe("first");
  expect(await last).toBe("current");
  expect(read).not.toHaveBeenCalled();
});

it.each(["before", "reserved"])("%s 취소는 이미 빈 슬롯이 있어도 API를 시작하지 않는다", async (when) => {
  const queue = createReadQueue(1),
    controller = new AbortController();
  const read = vi.fn(async () => "not dispatched");
  if (when === "before") controller.abort();
  const result = queue.run(read, controller.signal);
  controller.abort();
  await expect(result).rejects.toMatchObject({ kind: "aborted" });
  expect(read).not.toHaveBeenCalled();
  expect(await queue.run(async () => "next", new AbortController().signal)).toBe("next");
});

it.each([false, true])(
  "동기/비동기 조회 실패(%s) 후 다음 조회가 진행되고 실패를 자동 재시도하지 않는다",
  async (asyncFailure) => {
    const queue = createReadQueue(1),
      error = new Error("failure");
    const read = vi.fn(() => {
      if (asyncFailure) return Promise.reject(error);
      throw error;
    });
    const first = queue.run(read, new AbortController().signal);
    const second = queue.run(async () => "next", new AbortController().signal);
    await expect(first).rejects.toBe(error);
    expect(await second).toBe("next");
    expect(read).toHaveBeenCalledTimes(1);
  },
);

it("실행 중 취소는 실제 정리가 끝나기 전에 슬롯을 반환하지 않고 늦은 응답을 버린다", async () => {
  const queue = createReadQueue(1),
    held = deferred<string>(),
    controller = new AbortController();
  const read = vi.fn(() => held.promise);
  const first = queue.run(read, controller.signal);
  const rejected = expect(first).rejects.toMatchObject({ kind: "aborted" });
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  controller.abort();
  const next = vi.fn(async () => "current");
  const second = queue.run(next, new AbortController().signal);
  await Promise.resolve();
  expect(next).not.toHaveBeenCalled();
  held.resolve("late private data");
  await rejected;
  expect(await second).toBe("current");
});
