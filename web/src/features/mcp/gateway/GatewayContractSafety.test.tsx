import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useReducer } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayMcpPage } from "./GatewayMcpPage";
import { contractFormSchema, contractDraft, emptyContract, contractAddressableID } from "./contract-review";
import {
  mcpContractListSchema,
  mcpContractValidationSchema,
  mcpContractWriteSchema,
} from "@/shared/api/domains/mcp.schemas";
import { FeatureAccessHarness } from "@/test/feature-access";
import { renderScreen } from "@/test/render";
import { mockApi, apiFailure, type ApiHandler } from "@/test/api";

const runtime = vi.hoisted(() => ({
  id: "public-admin",
  scopes: ["admin:read", "observability:read", "mcp:admin"],
  readOnly: false,
}));
const notices = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: notices }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ scopes: runtime.scopes, user: { id: runtime.id } }) };
});
const original = {
  id: "public-contract",
  namespace: "gateway",
  name: "gateway_chat",
  title: "공개 계약",
  description: "선언",
  input_schema: '{"type":"object","properties":{"question":{"type":"string"}}}',
  output_schema: '{"type":"object","properties":{"answer":{"type":"string"}}}',
  risk_level: "high",
  timeout_ms: 1000,
  allowed_roles: "operator",
  cost_policy: "기본 비용",
  owner: "공개 담당",
  enabled: true,
  created_by: "public-admin",
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
};
const info = {
  endpoint: "/mcp/gateway",
  protocol_version: "2025-06-18",
  tools: [],
  contracts: [],
  resources: [],
  prompts: [],
  note: "",
};
const listKey = "GET /admin/mcp/contracts",
  saveKey = "POST /admin/mcp/contracts",
  deleteKey = "DELETE /admin/mcp/contracts";
function setup(handlers: Record<string, ApiHandler> = {}) {
  const api = mockApi({
    "GET /admin/gateway-mcp/info": () => info,
    [listKey]: () => ({ contracts: [original] }),
    [saveKey]: () => ({ id: original.id, ok: true }),
    [deleteKey]: () => ({ ok: true }),
    ...handlers,
  });
  let update = () => {};
  function Harness() {
    const [, rerender] = useReducer((value) => value + 1, 0);
    update = rerender;
    return (
      <FeatureAccessHarness featureId="mcp.gateway" readOnly={runtime.readOnly}>
        <GatewayMcpPage />
      </FeatureAccessHarness>
    );
  }
  const view = renderScreen(<Harness />);
  return { ...view, api, refresh: () => act(() => update()) };
}
async function edit() {
  const trigger = await screen.findByRole("button", { name: "수정" });
  await waitFor(() => expect(trigger).toBeEnabled());
  await userEvent.click(trigger);
  return screen.findByRole("dialog", { name: "도구 계약" });
}
const save = (dialog: HTMLElement) => within(dialog).getByRole("button", { name: "검토한 계약 저장" });
beforeEach(() => {
  runtime.id = "public-admin";
  runtime.scopes = ["admin:read", "observability:read", "mcp:admin"];
  runtime.readOnly = false;
  vi.clearAllMocks();
});

describe("MCP 계약 변경 안전성", () => {
  it("서버에서 정규화될 ID는 표시하되 편집·삭제하지 않는다", async () => {
    const { api } = setup({ [listKey]: () => ({ contracts: [{ ...original, id: " public-contract" }] }) });
    expect(await screen.findByRole("button", { name: "수정" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "삭제" })).toBeDisabled();
    expect(api.bodies(saveKey)).toEqual([]);
    expect(api.bodies(deleteKey)).toEqual([]);
  });
  it.each([401, 403])("계약 조회 %s는 이전 편집창과 목록을 숨긴다", async (status) => {
    let denied = false;
    const view = setup({
      [listKey]: () => {
        if (denied) throw apiFailure("private", status);
        return { contracts: [original] };
      },
    });
    await edit();
    denied = true;
    await act(() => view.client.invalidateQueries({ queryKey: ["mcp", "gateway", "contracts"] }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.queryByRole("table", { name: "MCP 도구 계약 레지스트리" })).not.toBeInTheDocument();
    expect(await screen.findByText("도구 계약 조회 권한을 다시 확인하세요.")).toBeVisible();
  });
  it("계정이 바뀐 뒤 도착한 저장 결과로 새 알림을 만들지 않는다", async () => {
    let resolve!: (value: unknown) => void;
    const pending = new Promise<unknown>((done) => {
      resolve = done;
    });
    const view = setup({ [saveKey]: () => pending });
    const dialog = await edit();
    await userEvent.type(within(dialog).getByLabelText("담당"), " 초안");
    await userEvent.click(save(dialog));
    await waitFor(() => expect(view.api.bodies(saveKey)).toHaveLength(1));
    runtime.id = "public-other";
    view.refresh();
    await act(async () => {
      resolve({ id: original.id, ok: true });
      await pending;
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(notices.success).not.toHaveBeenCalled();
    expect(notices.error).not.toHaveBeenCalled();
  });
  it("변경 없는 저장을 막고 출력 스키마를 그대로 보존하며 초점을 복구한다", async () => {
    const { api } = setup();
    const dialog = await edit();
    expect(save(dialog)).toBeDisabled();
    expect(within(dialog).getByLabelText("출력 스키마 (JSON)")).toHaveValue(original.output_schema);
    await userEvent.clear(within(dialog).getByLabelText("담당"));
    await userEvent.type(within(dialog).getByLabelText("담당"), "새 담당");
    expect(within(dialog).getByRole("region", { name: "계약 변경 비교" })).toHaveTextContent("새 담당");
    await userEvent.click(save(dialog));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(api.bodies(saveKey)).toEqual([{ ...contractDraft(original), timeout_ms: 1000, owner: "새 담당" }]);
    await waitFor(() => expect(screen.getByRole("button", { name: "수정" })).toHaveFocus());
  });
  it("출력 선언 제거는 변경 전후에 명시하고 빈 문자열로 저장한다", async () => {
    const { api } = setup();
    const dialog = await edit();
    await userEvent.clear(within(dialog).getByLabelText("출력 스키마 (JSON)"));
    expect(within(dialog).getByRole("region", { name: "계약 변경 비교" })).toHaveTextContent("출력 스키마");
    await userEvent.click(save(dialog));
    await waitFor(() => expect(api.bodies(saveKey)).toHaveLength(1));
    expect(api.bodies(saveKey)[0]).toMatchObject({ output_schema: "" });
  });
  it("알 수 없는 위험도는 낮음으로 바꾸지 않고 명시적 선택을 요구한다", async () => {
    const { api } = setup({ [listKey]: () => ({ contracts: [{ ...original, risk_level: "future" }] }) });
    const dialog = await edit();
    expect(within(dialog).getByLabelText("위험도*")).toHaveValue("future");
    await userEvent.type(within(dialog).getByLabelText("담당"), " 변경");
    await userEvent.click(save(dialog));
    expect(await within(dialog).findByText("지원하는 위험도를 직접 선택하세요.")).toBeVisible();
    expect(api.bodies(saveKey)).toEqual([]);
  });
  it.each(["입력 스키마 (JSON)", "출력 스키마 (JSON)"])(
    "잘못된 %s는 해당 입력 근처에 오류를 표시한다",
    async (label) => {
      const { api } = setup();
      const dialog = await edit();
      const field = within(dialog).getByLabelText(label);
      await userEvent.clear(field);
      await userEvent.type(field, "invalid");
      await userEvent.click(save(dialog));
      expect(await within(dialog).findByText(/64KB 이하의 올바른 JSON/)).toBeVisible();
      expect(field).toHaveFocus();
      expect(api.bodies(saveKey)).toEqual([]);
    },
  );
  it.each(["-1", "1.5", "9007199254740992", "Infinity"])("타임아웃 %s를 전송하지 않는다", async (timeout) => {
    const { api } = setup();
    const dialog = await edit();
    const field = within(dialog).getByLabelText("타임아웃(ms)");
    await userEvent.clear(field);
    await userEvent.type(field, timeout);
    await userEvent.click(save(dialog));
    expect(await within(dialog).findByText(/9,007,199,254,740,991 이하/)).toBeVisible();
    expect(api.bodies(saveKey)).toEqual([]);
  });
  it.each(["readOnly", "scope"])("%s 변경 후 초안을 보존하고 저장만 차단한다", async (kind) => {
    const view = setup();
    const dialog = await edit();
    await userEvent.type(within(dialog).getByLabelText("담당"), " 초안");
    if (kind === "readOnly") runtime.readOnly = true;
    else runtime.scopes = ["admin:read", "observability:read"];
    view.refresh();
    expect(within(dialog).getByLabelText("담당")).toHaveValue("공개 담당 초안");
    expect(save(dialog)).toBeDisabled();
    expect(view.api.bodies(saveKey)).toEqual([]);
  });
  it("계정 변경 시 이전 편집 입력을 폐기한다", async () => {
    const view = setup();
    await edit();
    runtime.id = "public-other";
    view.refresh();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(view.api.bodies(saveKey)).toEqual([]);
  });
  it.each(["save", "delete"])("최신 계약이 바뀌면 %s를 보내지 않는다", async (kind) => {
    let reads = 0;
    const { api } = setup({
      [listKey]: () => ({
        contracts: [{ ...original, owner: ++reads > 1 ? "변경된 담당" : original.owner }],
      }),
    });
    let dialog: HTMLElement;
    if (kind === "save") {
      dialog = await edit();
      await userEvent.type(within(dialog).getByLabelText("담당"), " 초안");
      await userEvent.click(save(dialog));
    } else {
      await userEvent.click(await screen.findByRole("button", { name: "삭제" }));
      dialog = await screen.findByRole("dialog");
      const button = within(dialog).getByRole("button", { name: "검토한 계약 삭제" });
      expect(button).toBeDisabled();
      await userEvent.type(within(dialog).getByLabelText(/확인 문구/), original.name);
      await userEvent.click(button);
    }
    expect(await within(dialog).findByText(/계약이 변경되거나 삭제되었습니다/)).toBeVisible();
    expect(api.bodies(saveKey)).toEqual([]);
    expect(api.bodies(deleteKey)).toEqual([]);
  });
  it("전송 후 오류를 재시도하지 않고 초안을 유지한다", async () => {
    const { api } = setup({
      [saveKey]: () => {
        throw apiFailure("private", 503);
      },
    });
    const dialog = await edit();
    await userEvent.type(within(dialog).getByLabelText("담당"), " 초안");
    await userEvent.dblClick(save(dialog));
    expect(await within(dialog).findByText(/변경 요청을 전송했습니다/)).toBeVisible();
    expect(api.bodies(saveKey)).toHaveLength(1);
    expect(save(dialog)).toBeDisabled();
  });
  it("조회 실패를 정상 빈 목록으로 표시하지 않는다", async () => {
    setup({
      [listKey]: () => {
        throw apiFailure("private");
      },
    });
    await screen.findByRole("alert");
    expect(screen.queryByText("등록된 도구 계약이 없습니다.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "계약 등록" })).toBeDisabled();
  });
  it("계약 조회 권한 없으면 연결 정보만 조회한다", async () => {
    runtime.scopes = ["admin:read", "mcp:admin"];
    const { api } = setup();
    await screen.findByText("/mcp/gateway");
    expect(api.bodies(listKey)).toEqual([]);
    expect(screen.queryByRole("button", { name: "계약 등록" })).not.toBeInTheDocument();
  });
  it("검증 불가를 정상으로 보고하지 않고 읽기 전용에서도 비교한다", async () => {
    runtime.readOnly = true;
    setup({
      "POST /admin/mcp/contracts/validate": () => ({
        checked: 1,
        drift_count: 0,
        missing_count: 0,
        note: "",
        results: [
          {
            contract_id: original.id,
            namespace: "external",
            name: original.name,
            risk_level: "high",
            status: "not_checkable",
            detail: "",
            declared_only: [],
            live_only: [],
          },
        ],
      }),
    });
    await userEvent.click(await screen.findByRole("button", { name: "드리프트 검증" }));
    expect(await screen.findByText("검증 불가")).toBeVisible();
    expect(notices.success).not.toHaveBeenCalledWith("드리프트가 없습니다.");
    expect(screen.getByRole("button", { name: "계약 등록" })).toBeDisabled();
  });
});

describe("MCP 계약 응답·입력 계약", () => {
  it.each([" public", "public ", "\u0085public", "public\n", "\ud800", ""])(
    "모호한 ID를 정규화하지 않고 거부한다: %s",
    (id) => {
      expect(contractAddressableID(id)).toBe(false);
    },
  );
  it("쿼리 인코딩으로 정확히 지정 가능한 ID는 허용한다", () => {
    expect(contractAddressableID("public / 계약")).toBe(true);
  });
  it.each([
    {},
    { contracts: null },
    { contracts: [{}] },
    { contracts: [original, original] },
    { contracts: [{ ...original, output_schema: undefined }] },
  ])("불완전 목록을 빈 목록으로 만들지 않는다", (value) => {
    expect(mcpContractListSchema.safeParse(value).success).toBe(false);
  });
  it("알 수 없는 위험도는 읽되 안전하지 않은 정수는 거부한다", () => {
    expect(
      mcpContractListSchema.safeParse({ contracts: [{ ...original, risk_level: "future" }] }).success,
    ).toBe(true);
    expect(
      mcpContractListSchema.safeParse({
        contracts: [{ ...original, timeout_ms: Number.MAX_SAFE_INTEGER + 1 }],
      }).success,
    ).toBe(false);
  });
  it("성공 응답에 명시적 ok가 필요하다", () => {
    expect(mcpContractWriteSchema.safeParse({}).success).toBe(false);
    expect(mcpContractWriteSchema.safeParse({ ok: false }).success).toBe(false);
    expect(mcpContractWriteSchema.safeParse({ id: "public", ok: true }).success).toBe(true);
  });
  it("실제 Go 검증 응답의 생략 필드와 건수 정합성을 검증한다", () => {
    const data = {
      checked: 1,
      drift_count: 0,
      missing_count: 0,
      note: "",
      results: [{ contract_id: "a", namespace: "gateway", name: "a", risk_level: "low", status: "ok" }],
    };
    expect(mcpContractValidationSchema.safeParse(data).success).toBe(true);
    expect(mcpContractValidationSchema.safeParse({ ...data, checked: 0 }).success).toBe(false);
    expect(mcpContractValidationSchema.safeParse({ ...data, results: undefined }).success).toBe(false);
  });
  it("입력·출력 스키마에 UTF-8 크기 상한을 적용한다", () => {
    for (const field of ["input_schema", "output_schema"])
      expect(
        contractFormSchema.safeParse({
          ...emptyContract,
          name: "a",
          [field]: JSON.stringify("가".repeat(22000)),
        }).success,
      ).toBe(false);
  });
});
