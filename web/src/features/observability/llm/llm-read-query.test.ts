import { expect, it } from "vitest";

import { AppError } from "@/shared/api/error";
import { assertLLMReadOwner, llmReadError, llmReadQueryOptions } from "./llm-read-query";

const owner = { id: 1, readable: true, prefixes: ["public_private_"], isCurrent: () => true };
it("projects denial metadata without retaining server messages, details or causes", () => {
  const error = llmReadError(
    new AppError("PRIVATE-SERVER-MESSAGE", {
      kind: "permission",
      status: 403,
      code: "PRIVATE-CODE",
      details: { note: "PRIVATE-NOTE" },
      cause: new Error("PRIVATE-CAUSE"),
      requestId: "public-request-id",
    }),
    owner,
  );
  expect(error).toMatchObject({ kind: "permission", status: 403, requestId: "public-request-id" });
  expect(error.details).toBeUndefined();
  expect(error.cause).toBeUndefined();
  expect(error.code).toBeUndefined();
  expect(error.message).not.toContain("PRIVATE");
});
it("does not publish credential-prefixed request IDs", () => {
  const error = llmReadError(
    new AppError("private", { kind: "auth", status: 401, requestId: `public_private_${"a".repeat(40)}` }),
    owner,
  );
  expect(error.requestId).toBeUndefined();
});
it("blocks both aborted callbacks and a response from a retired owner", async () => {
  const controller = new AbortController();
  controller.abort();
  expect(() => assertLLMReadOwner(owner, controller.signal)).toThrow();
  let current = true;
  const scoped = { ...owner, isCurrent: () => current };
  const options = llmReadQueryOptions(scoped, ["observability", "llm", "test"], async () => {
    current = false;
    return { private: "response" };
  });
  await expect(options.queryFn({ signal: new AbortController().signal })).rejects.toMatchObject({
    kind: "aborted",
  });
});
