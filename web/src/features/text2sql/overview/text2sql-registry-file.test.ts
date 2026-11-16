import { expect, it } from "vitest";
import { readRegistryFile, registryActionError, registryFileLimit } from "./text2sql-registry-file";

function file(value: unknown, name = "registry.json"): File {
  const content = JSON.stringify(value);
  return { name, size: content.length, text: async () => content } as File;
}
it("서버 내보내기 형식과 등록 필드를 보존한다", async () => {
  const value = {
    version: 1,
    schema: "analytics",
    tables: [{ schema_name: "analytics", table_name: "orders", description: "주문", enabled: true }],
    columns: [{ schema_name: "analytics", table_name: "orders", column_name: "phone", sensitivity: "mask" }],
  };
  expect(await readRegistryFile(file(value))).toEqual(value);
});
it.each([
  null,
  [],
  {},
  { tables: "orders" },
  { tables: [{}] },
  { columns: [1] },
  { columns: [{ schema_name: "s", table_name: "t", column_name: "c", sensitivity: "unsafe" }] },
  { version: 2, tables: [{ schema_name: "s", table_name: "t" }] },
])("잘못된 입력 %j는 서버에 보내기 전에 거부한다", async (value) => {
  await expect(readRegistryFile(file(value))).rejects.toMatchObject({ code: "t2s_file_format" });
});
it("빈 파일·잘못된 확장자·크기 제한을 읽기 전에 검사한다", async () => {
  for (const value of [
    { name: "a.json", size: 0 },
    { name: "a.txt", size: 10 },
    { name: "a.json", size: registryFileLimit + 1 },
  ])
    await expect(readRegistryFile(value as File)).rejects.toMatchObject({ code: "t2s_file_size" });
});
it("파싱 오류에 파일 원문을 노출하지 않는다", async () => {
  const error = await readRegistryFile({
    name: "a.json",
    size: 10,
    text: async () => "private-source",
  } as File).catch((cause: unknown) => cause);
  expect(registryActionError(error, "실패")).not.toContain("private-source");
  expect(registryActionError(error, "실패")).toContain("JSON 형식");
});
