import { afterEach, describe, expect, it, vi } from "vitest";
import { readProbeCsvFile, validateProbeCsvText, probeCsvMaxBytes } from "./probe-csv-file";

const header = [
  "pack_id",
  "pack_name",
  "category",
  "pack_severity",
  "requires_approval",
  "case_id",
  "case_key",
  "expected_policy",
  "evaluator_type",
  "severity",
  "target_types",
  "risk_tags",
  "input_template",
  "vibe_probe_csv_format",
];
const cell = (value: string) => (/[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value);
function marked(overrides: Record<string, string | undefined> = {}, names = header) {
  const row: Record<string, string | undefined> = {
    case_key: "case",
    input_template: "prompt",
    vibe_probe_csv_format: "probe-v1",
    ...overrides,
  };
  return `${names.join(",")}\r\n${names.map((name) => cell(row[name] ?? "")).join(",")}\r\n`;
}
const context = () => ({ signal: new AbortController().signal, assertCurrent: vi.fn() });
const legacy = "case_key,input_template\r\nk,t\r\n";
afterEach(() => vi.restoreAllMocks());

describe("probe CSV file validation", () => {
  it.each([
    new File([legacy], "prompts.txt", { type: "text/csv" }),
    new File([legacy], "prompts.csv", { type: "text/html" }),
    new File([], "prompts.csv", { type: "text/csv" }),
    new File([new Uint8Array(probeCsvMaxBytes + 1)], "prompts.csv", { type: "text/csv" }),
  ])("rejects metadata before reading the file ($name, $type, $size)", async (file) => {
    const read = vi.spyOn(FileReader.prototype, "readAsArrayBuffer");
    await expect(readProbeCsvFile(file, context())).rejects.toMatchObject({ code: "invalid_csv" });
    expect(read).not.toHaveBeenCalled();
  });

  it.each(["", "text/csv", "text/plain", "application/csv", "application/vnd.ms-excel"])(
    "accepts %s and retains BOM, CRLF and Unicode exactly",
    async (type) => {
      const text = "\ufeffcase_key,input_template\r\nk,한글😀\r\n";
      await expect(
        readProbeCsvFile(new File([text], "PROMPTS.CSV", { type }), context()),
      ).resolves.toMatchObject({ text, filename: "PROMPTS.CSV", rows: 1, validRows: 1, format: "legacy" });
    },
  );

  it("rejects invalid UTF-8 instead of replacing input bytes", async () => {
    const bytes = new Uint8Array([...new TextEncoder().encode("case_key,input_template\nk,"), 0xc3, 0x28]);
    await expect(readProbeCsvFile(new File([bytes], "invalid.csv"), context())).rejects.toMatchObject({
      code: "invalid_csv",
      message: expect.stringContaining("UTF-8"),
    });
  });

  it.each([
    "case_key,input_template\nk,t",
    "\ncase_key,input_template\n\nk,t\n\n",
    'case_key,input_template\n"key,one","line 1\nline ""2"""\n',
    "case_key,input_template\r\nk,t\r",
    "input_template,case_key,pack_id\nt,k,\n",
    "case_key,input_template\nk,'=SUM(A1)\n",
    'case_key,input_template\nk,"vibe-text-v1:null"\n',
  ])("accepts strict legacy CSV syntax (%#)", async (text) => {
    await expect(validateProbeCsvText(text, context())).resolves.toMatchObject({
      text,
      rows: 1,
      validRows: 1,
      skippedRows: 0,
      format: "legacy",
    });
  });

  it("counts valid and skipped required cells without changing input", async () => {
    const text = "case_key,input_template\nk,t\n,skip\nblank, \n";
    await expect(validateProbeCsvText(text, context())).resolves.toMatchObject({
      text,
      rows: 3,
      validRows: 1,
      skippedRows: 2,
    });
  });

  it.each([
    "",
    "case_key,input_template\n",
    "case_key,input_template\n,\n",
    "case_key\nk\n",
    "case_key,input_template,unknown\nk,t,x\n",
    "case_key,input_template,CASE_KEY\nk,t,k\n",
    "case_key,input_template\nk\n",
    "case_key,input_template\nk,t,x\n",
    'case_key,input_template\nk,"unterminated',
    'case_key,input_template\nk,a"b\n',
    'case_key,input_template\nk,"text" trailing\n',
    'case_key,input_template\nk,"""\n',
    "case_key,input_template\nk,\0\n",
    "case_key,input_template\nk,\ud800\n",
  ])("rejects the complete invalid file before upload (%#)", async (text) => {
    await expect(validateProbeCsvText(text, context())).rejects.toMatchObject({ code: "invalid_csv" });
  });

  it.each([
    "=SUM(1,2)",
    "+cmd",
    "-1",
    "@test",
    "'literal",
    " leading",
    "trailing ",
    "\tvalue",
    "\rvalue",
    "\nvalue",
    "\ufeffvalue",
    "vibe-text-v1:literal",
    "한글😀",
    'a,"b"\nsecond',
  ])("accepts reversible versioned text (%#)", async (value) => {
    const text = marked({ input_template: `vibe-text-v1:${JSON.stringify(value)}` }, [...header].reverse());
    await expect(validateProbeCsvText(text, context())).resolves.toMatchObject({
      text,
      format: "probe-v1",
      validRows: 1,
    });
  });

  it("accepts encoded lists with pipes, empty members and Unicode", async () => {
    await expect(
      validateProbeCsvText(
        marked({ target_types: 'vibe-list-v1:["model|other",""," 한글😀 "]', risk_tags: "vibe-list-v1:[]" }),
        context(),
      ),
    ).resolves.toMatchObject({ validRows: 1 });
  });

  it.each([
    { vibe_probe_csv_format: "probe-v2" },
    { input_template: "vibe-text-v1:null" },
    { input_template: "vibe-text-v1:[]" },
    { input_template: 'vibe-text-v1: "text"' },
    { input_template: 'vibe-text-v1:"\\u0000"' },
    { input_template: 'vibe-text-v1:"\\ud800"' },
    { target_types: "vibe-list-v1:null" },
    { target_types: "vibe-list-v1:[null]" },
    { risk_tags: 'vibe-list-v1:["\\udfff"]' },
    { risk_tags: 'vibe-list-v1: ["value"]' },
  ])("rejects invalid versioned encodings (%#)", async (overrides) => {
    await expect(validateProbeCsvText(marked(overrides), context())).rejects.toMatchObject({
      code: "invalid_csv",
    });
  });

  it("requires every versioned column and rejects an invalid trailing row", async () => {
    await expect(
      validateProbeCsvText(
        marked(
          {},
          header.filter((name) => name !== "risk_tags"),
        ),
        context(),
      ),
    ).rejects.toMatchObject({ code: "invalid_csv" });
    const text = `${marked()}broken,row\n`;
    await expect(validateProbeCsvText(text, context())).rejects.toMatchObject({ code: "invalid_csv" });
  });

  it("accepts exactly 8 MiB and rejects one additional UTF-8 byte", async () => {
    const prefix = "case_key,input_template\nk,";
    const text =
      prefix +
      "한".repeat(Math.floor((probeCsvMaxBytes - prefix.length) / 3)) +
      "x".repeat((probeCsvMaxBytes - prefix.length) % 3);
    expect(new TextEncoder().encode(text).byteLength).toBe(probeCsvMaxBytes);
    await expect(validateProbeCsvText(text, context())).resolves.toMatchObject({ validRows: 1 });
    await expect(validateProbeCsvText(text + "x", context())).rejects.toMatchObject({ code: "invalid_csv" });
  });

  it("allows cancellation while validating a large file", async () => {
    const controller = new AbortController();
    const pending = validateProbeCsvText("case_key,input_template\nk," + "x".repeat(200_000), {
      signal: controller.signal,
      assertCurrent: vi.fn(),
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ kind: "aborted" });
  });

  it("aborts native file reading and removes its callbacks", async () => {
    const controller = new AbortController();
    const abort = vi.spyOn(FileReader.prototype, "abort");
    const reading = readProbeCsvFile(new File([legacy], "prompts.csv"), {
      signal: controller.signal,
      assertCurrent: vi.fn(),
    });
    controller.abort();
    await expect(reading).rejects.toMatchObject({ kind: "aborted" });
    expect(abort).toHaveBeenCalledOnce();
    const reader = abort.mock.instances[0];
    if (!(reader instanceof FileReader)) throw new Error("native reader missing");
    expect(reader?.onload).toBeNull();
    expect(reader?.onerror).toBeNull();
    expect(reader?.onabort).toBeNull();
  });
});
