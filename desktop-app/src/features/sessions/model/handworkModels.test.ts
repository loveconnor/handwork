import { afterEach, expect, it } from "vitest";
import {
  defaultModelId,
  modelsFor,
  nativeModelId,
  resetHarnessModelOverlays,
  resolveModel,
  setHarnessModels,
} from "./models";
afterEach(resetHarnessModelOverlays);
it("offers no invented Handwork model while the provider catalog is unavailable", () => {
  resetHarnessModelOverlays();
  expect(modelsFor("handwork")).toEqual([]);
  expect(defaultModelId("handwork")).toBe("");
  expect(resolveModel("handwork")).toMatchObject({
    id: "",
    name: "Select model",
    nativeId: "",
  });
  expect(resolveModel("handwork", "handwork:default")).toMatchObject({
    id: "",
    name: "Select model",
  });
  expect(nativeModelId("handwork:default")).toBe("");
});
it("resolves old placeholder sessions to a real connected provider model", () => {
  const model = {
    id: "handwork:provider-a/model-one",
    harness: "handwork" as const,
    name: "Model One",
    nativeId: "provider-a/model-one",
    provider: { id: "provider-a", name: "Provider A" },
  };
  setHarnessModels("handwork", [model]);
  expect(resolveModel("handwork")).toEqual(model);
  expect(resolveModel("handwork", "handwork:default")).toEqual(model);
  expect(nativeModelId(resolveModel("handwork", "handwork:default"))).toBe(
    "provider-a/model-one",
  );
});
it("retains a saved concrete model when disconnected", () => {
  resetHarnessModelOverlays();
  expect(
    resolveModel("handwork", "handwork:provider-a/model-one"),
  ).toMatchObject({
    id: "handwork:provider-a/model-one",
    nativeId: "provider-a/model-one",
  });
});
