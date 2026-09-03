import { describe, expect, it } from "vitest";

import { routeErrorMessage } from "@/app/router/route-error-message";

function routeError(status: number, statusText: string, data: unknown = undefined): unknown {
  return { status, statusText, data, internal: true };
}

describe("routeErrorMessage", () => {
  it.each([
    [401, "로그인이 필요합니다. (HTTP 401)"],
    [403, "이 화면에 접근할 권한이 없습니다. (HTTP 403)"],
    [404, "요청한 화면을 찾을 수 없습니다. (HTTP 404)"],
    [405, "허용되지 않은 요청 방식입니다. (HTTP 405)"],
    [408, "화면 요청 시간이 초과되었습니다. (HTTP 408)"],
    [429, "요청이 너무 많습니다. 잠시 후 다시 시도하세요. (HTTP 429)"],
    [500, "화면을 처리하는 중 서버 오류가 발생했습니다. (HTTP 500)"],
    [502, "서비스에 일시적으로 연결할 수 없습니다. (HTTP 502)"],
    [503, "서비스에 일시적으로 연결할 수 없습니다. (HTTP 503)"],
    [504, "서비스에 일시적으로 연결할 수 없습니다. (HTTP 504)"],
  ])("returns a stable message for HTTP %i", (status, expected) => {
    expect(routeErrorMessage(routeError(status, "raw status text"))).toBe(expected);
  });

  it("returns only the stable message and HTTP code", () => {
    const message = routeErrorMessage(
      routeError(503, "Service Unavailable with private upstream detail", {
        message: "private upstream detail",
      }),
    );

    expect(message).toBe("서비스에 일시적으로 연결할 수 없습니다. (HTTP 503)");
    expect(message).not.toContain("Service Unavailable");
    expect(message).not.toContain("private upstream detail");
  });

  it("does not expose an unexpected Error message", () => {
    const message = routeErrorMessage(new Error("private browser detail"));

    expect(message).toBe("예기치 못한 화면 오류가 발생했습니다.");
    expect(message).not.toContain("private browser detail");
  });

  it("uses a safe generic message for an unmapped HTTP status", () => {
    expect(routeErrorMessage(routeError(418, "I'm a teapot"))).toBe(
      "요청한 화면을 표시할 수 없습니다. (HTTP 418)",
    );
  });
});
