import { describe, expect, it } from "vitest";

import { endpoints } from "@/shared/api/endpoints";
import { withPathParams } from "@/shared/api/endpoint-factory";
import { routingEditEndpoints } from "./routing-edit";
import { routingDeleteEndpoints, routingDeleteResponseSchema } from "./routing-delete";

describe("라우팅 삭제의 엄격한 요청 확인 계약", () => {
  it("기존 GET/DELETE만 등록하고 원시 목록 계약을 공유한다", () => {
    expect(endpoints.domains.routingDelete).toBe(routingDeleteEndpoints);
    expect(routingDeleteEndpoints.list).toBe(routingEditEndpoints.list);
    expect(routingDeleteEndpoints.remove.method).toBe("DELETE");
    expect(routingDeleteEndpoints.remove.path).toBe(endpoints.domains.routing.rules.remove.path);
    expect(withPathParams(routingDeleteEndpoints.remove, { id: "route_exact_a" }).path).toBe(
      "/admin/routing-rules/route_exact_a",
    );
  });

  it("원래 ID와 deleted 상태만 그대로 반환하며 미래 필드는 표시하지 않는다", () => {
    expect(
      routingDeleteResponseSchema.parse({ id: "route_exact_a", status: "deleted", future: "extra" }),
    ).toEqual({ id: "route_exact_a", status: "deleted" });
  });

  it.each([
    null,
    [],
    {},
    { id: "route_exact_a" },
    { status: "deleted" },
    { id: null, status: "deleted" },
    { id: 12, status: "deleted" },
    { id: "route_exact_a", status: null },
    { id: "route_exact_a", status: true },
    { id: "route_exact_a", status: "" },
    { id: "route_exact_a", status: "Deleted" },
    { id: "route_exact_a", status: "deleted " },
    { id: "route_exact_a", status: "ok" },
  ])("확인되지 않은 응답을 삭제 성공으로 바꾸지 않는다: %j", (raw) => {
    expect(routingDeleteResponseSchema.safeParse(raw).success).toBe(false);
  });

  it("응답 ID를 정규화하거나 서버의 멱등 응답을 실제 영향행 수로 바꾸지 않는다", () => {
    expect(routingDeleteResponseSchema.parse({ id: " route_other ", status: "deleted" })).toEqual({
      id: " route_other ",
      status: "deleted",
    });
    // Exact expected-ID and safe-identity checks belong to the selected operation.
    // Existing unrelated consumers retain their compatibility adapter unchanged.
    expect(endpoints.domains.routing.rules.remove.schema.safeParse({}).success).toBe(true);
  });
});
