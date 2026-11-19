import { describe, expect, it } from "vitest";
import { legacyRoutes } from "@/config/legacy-route-map";
import { modelLegacyHandoff } from "./legacy-model-handoff";
const base = legacyRoutes.modelContracts;
const model = { id: "한글 +%2F?&#/model", provider_ref: "prv_" + "A".repeat(43), source: "live" as const };
describe("model Legacy handoff", () => {
  it("preserves exact model/provider/source without a display-name query", () => {
    const result = modelLegacyHandoff(base, model, true, []);
    expect(result.sameModel).toBe(true);
    expect(Object.fromEntries(new URLSearchParams(result.href?.split("?")[1]))).toEqual({
      model: model.id,
      provider_ref: model.provider_ref,
      source: model.source,
    });
  });
  it.each(["live", "cache", "agent_route"] as const)("preserves %s identity", (source) => {
    expect(modelLegacyHandoff(base, { ...model, source }, true, []).sameModel).toBe(true);
  });
  it.each(
    [
      "",
      " padded ",
      "a\nb",
      "a\\b",
      "a".repeat(4097),
      "\ud800",
      "한".repeat(1000),
      "vc_sk_" + "S".repeat(40),
    ].map((id, index) => ({ id, index })),
  )("withholds unsafe or unbounded identity $index", ({ id }) => {
    expect(modelLegacyHandoff(base, { ...model, id }, true, ["vc_sk_"])).toEqual({
      href: base,
      sameModel: false,
    });
  });
  it("does not invent support in an old backend or an unresolved selection", () => {
    expect(modelLegacyHandoff(base, model, false, []).sameModel).toBe(false);
    expect(modelLegacyHandoff(base, undefined, true, []).sameModel).toBe(false);
  });
  it("honors custom destinations without attaching a different contract", () => {
    const custom = "/admin#/custom?public=ok";
    expect(modelLegacyHandoff(custom, model, true, [])).toEqual({ href: custom, sameModel: false });
  });
  it.each(["https://remote.invalid/admin", "/administer", "/admin#/x?secret=vc_sk_" + "X".repeat(40)])(
    "rejects unsafe destination %s",
    (href) => {
      expect(modelLegacyHandoff(href, model, true, ["vc_sk_"])).toEqual({ sameModel: false });
    },
  );
  it("requires the opaque provider reference", () => {
    expect(modelLegacyHandoff(base, { ...model, provider_ref: "visible name" }, true, []).sameModel).toBe(
      false,
    );
  });
});
