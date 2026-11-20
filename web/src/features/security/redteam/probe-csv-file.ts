import { AppError } from "@/shared/api/error";

export const probeCsvMaxBytes = 8 * 1024 * 1024;
const columns = [
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
] as const;
const versionColumn = "vibe_probe_csv_format";
const textPrefix = "vibe-text-v1:";
const listPrefix = "vibe-list-v1:";
const allowedTypes = new Set(["", "text/csv", "text/plain", "application/csv", "application/vnd.ms-excel"]);
const trimSpace = (value: string) => value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
const invalid = (message: string) => new AppError(message, { kind: "contract", code: "invalid_csv" });

export interface ProbeCsvReadContext {
  signal: AbortSignal;
  assertCurrent: () => void;
}
export interface PreparedProbeCsv {
  text: string;
  filename: string;
  format: "legacy" | "probe-v1";
  rows: number;
  validRows: number;
  skippedRows: number;
}
function assertCurrent(context: ProbeCsvReadContext): void {
  if (context.signal.aborted) throw new AppError("이전 CSV 가져오기입니다.", { kind: "aborted" });
  context.assertCurrent();
}
function supportedText(value: unknown): value is string {
  return typeof value === "string" && !value.includes("\0") && !/[\uD800-\uDFFF]/u.test(value);
}
function decodeCell(value: string, marked: boolean): string {
  if (marked && value.startsWith(textPrefix)) {
    try {
      const encoded = value.slice(textPrefix.length);
      if (!encoded.startsWith('"')) throw new Error("expected quoted string");
      const decoded: unknown = JSON.parse(encoded);
      if (!supportedText(decoded)) throw new Error("invalid text");
      return decoded;
    } catch {
      throw invalid("CSV 텍스트 인코딩이 올바르지 않습니다.");
    }
  }
  if (!supportedText(value)) throw invalid("CSV에 지원하지 않는 문자가 있습니다.");
  return value;
}
function validateList(value: string): void {
  if (!value.startsWith(listPrefix)) return;
  try {
    const encoded = value.slice(listPrefix.length);
    if (!encoded.startsWith("[")) throw new Error("expected array");
    const decoded: unknown = JSON.parse(encoded);
    if (!Array.isArray(decoded) || !decoded.every(supportedText)) throw new Error("invalid list");
  } catch {
    throw invalid("CSV 목록 인코딩이 올바르지 않습니다.");
  }
}

/** Validate every row without retaining a parsed copy of the uploaded catalogue. */
export async function validateProbeCsvText(
  text: string,
  context: ProbeCsvReadContext,
): Promise<Omit<PreparedProbeCsv, "filename">> {
  assertCurrent(context);
  if (text.length > probeCsvMaxBytes || new TextEncoder().encode(text).byteLength > probeCsvMaxBytes)
    throw invalid("CSV 파일은 8 MiB 이하여야 합니다.");
  // Match Go encoding/csv newline handling. The original upload text is unchanged.
  const source = text.replaceAll("\r\n", "\n").replace(/\r$/u, "");
  let header: string[] | undefined;
  let marked = false;
  let rows = 0;
  let validRows = 0;
  const consumeRow = (cells: string[]) => {
    if (!header) {
      const names = cells.map((value) => trimSpace(value).toLowerCase());
      const allowed = new Set<string>([...columns, versionColumn]);
      if (
        new Set(names).size !== names.length ||
        names.some((name) => !allowed.has(name)) ||
        !names.includes("case_key") ||
        !names.includes("input_template")
      )
        throw invalid(
          "CSV 헤더를 확인하세요. case_key와 input_template 열이 필요하며 중복·알 수 없는 열은 허용하지 않습니다.",
        );
      marked = names.includes(versionColumn);
      if (marked && (names.length !== columns.length + 1 || columns.some((name) => !names.includes(name))))
        throw invalid("버전이 표시된 CSV에는 내보낸 모든 열이 필요합니다.");
      header = names;
      return;
    }
    rows++;
    if (cells.length !== header.length) throw invalid(`CSV 행 ${rows + 1}의 열 수가 헤더와 다릅니다.`);
    if (marked && cells[header.indexOf(versionColumn)] !== "probe-v1")
      throw invalid(`CSV 행 ${rows + 1}의 형식 버전을 지원하지 않습니다.`);
    const values = cells.map((value) => decodeCell(value, marked));
    if (marked)
      for (const name of ["target_types", "risk_tags"]) validateList(values[header.indexOf(name)] ?? "");
    if (
      trimSpace(values[header.indexOf("case_key")] ?? "") &&
      trimSpace(values[header.indexOf("input_template")] ?? "")
    )
      validRows++;
  };

  let cursor = source.startsWith("\ufeff") ? 1 : 0;
  let fieldStart = cursor;
  let mode: "start" | "plain" | "quoted" | "closed" = "start";
  let closedValue = "";
  let escaped = false;
  let fields: string[] = [];
  let yieldAt = cursor + 65_536;
  const appendField = (end: number) => {
    fields.push(mode === "closed" ? closedValue : source.slice(fieldStart, end));
    if (fields.length > (header?.length ?? columns.length + 1)) throw invalid("CSV 행에 열이 너무 많습니다.");
  };
  for (; cursor < source.length; cursor++) {
    if (cursor >= yieldAt) {
      assertCurrent(context);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      assertCurrent(context);
      yieldAt = cursor + 65_536;
    }
    const char = source.charAt(cursor);
    if (mode === "quoted") {
      if (char === '"') {
        if (source.charAt(cursor + 1) === '"') {
          escaped = true;
          cursor++;
        } else {
          closedValue = source.slice(fieldStart, cursor);
          if (escaped) closedValue = closedValue.replaceAll('""', '"');
          mode = "closed";
        }
      }
      continue;
    }
    if (mode === "closed" && char !== "," && char !== "\n")
      throw invalid("CSV 따옴표 뒤에 올바르지 않은 문자가 있습니다.");
    if (char === "," || char === "\n") {
      if (!(char === "\n" && fields.length === 0 && mode === "start")) {
        appendField(cursor);
        if (char === "\n") {
          consumeRow(fields);
          fields = [];
        }
      }
      mode = "start";
      fieldStart = cursor + 1;
      continue;
    }
    if (mode === "start") {
      if (char === '"') {
        mode = "quoted";
        fieldStart = cursor + 1;
        escaped = false;
      } else mode = "plain";
    } else if (char === '"') throw invalid("CSV 따옴표 형식이 올바르지 않습니다.");
  }
  if (mode === "quoted") throw invalid("CSV의 닫는 따옴표가 없습니다.");
  if (mode !== "start" || fields.length > 0 || fieldStart < source.length) {
    appendField(cursor);
    consumeRow(fields);
  }
  assertCurrent(context);
  if (!header || rows === 0) throw invalid("CSV에는 헤더와 데이터 행이 필요합니다.");
  if (validRows === 0) throw invalid("가져올 프롬프트가 없습니다. case_key와 input_template을 확인하세요.");
  return { text, format: marked ? "probe-v1" : "legacy", rows, validRows, skippedRows: rows - validRows };
}

export async function readProbeCsvFile(file: File, context: ProbeCsvReadContext): Promise<PreparedProbeCsv> {
  assertCurrent(context);
  if (
    !/\.csv$/iu.test(file.name) ||
    !allowedTypes.has(file.type.split(";", 1)[0]?.trim().toLowerCase() ?? "")
  )
    throw invalid("CSV 확장자와 파일 형식을 확인하세요.");
  if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > probeCsvMaxBytes)
    throw invalid("CSV 파일은 비어 있지 않은 8 MiB 이하 파일이어야 합니다.");
  const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    const cleanup = () => {
      reader.onload = null;
      reader.onerror = null;
      reader.onabort = null;
      context.signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      if (reader.readyState === FileReader.LOADING) reader.abort();
      reject(new AppError("CSV 읽기를 취소했습니다.", { kind: "aborted" }));
    };
    reader.onload = () => {
      const value = reader.result;
      cleanup();
      if (value === null || typeof value === "string") reject(invalid("CSV 파일을 읽지 못했습니다."));
      else resolve(value);
    };
    reader.onerror = () => {
      cleanup();
      reject(invalid("CSV 파일을 읽지 못했습니다."));
    };
    reader.onabort = abort;
    context.signal.addEventListener("abort", abort, { once: true });
    if (context.signal.aborted) {
      abort();
      return;
    }
    try {
      reader.readAsArrayBuffer(file);
    } catch {
      cleanup();
      reject(invalid("CSV 파일을 읽지 못했습니다."));
    }
  });
  assertCurrent(context);
  if (bytes.byteLength !== file.size || bytes.byteLength > probeCsvMaxBytes)
    throw invalid("CSV 파일 크기를 확인할 수 없습니다.");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(new Uint8Array(bytes));
  } catch {
    throw invalid("CSV 파일은 올바른 UTF-8 형식이어야 합니다.");
  }
  return { ...(await validateProbeCsvText(text, context)), filename: file.name };
}
