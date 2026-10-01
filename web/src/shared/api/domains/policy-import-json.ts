import { AppError } from "@/shared/api/error";

export const policyImportLimits = { bytes: 4 * 1024 * 1024, policies: 1000, rules: 10000, depth: 64 };
export class ExactPolicyNumber {
  #token: string;
  constructor(token: string) {
    this.#token = token;
  }
  get token() {
    return this.#token;
  }
}
export class PolicyImportProblem extends AppError {
  constructor(message: string) {
    super(message, { kind: "contract" });
  }
}
export function importProblem(message: string): never {
  throw new PolicyImportProblem(message);
}
// Decimal-value comparison, not binary-floating-point exactness or byte fidelity.
function decimal(token: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token);
  if (!match) return importProblem("숫자 형식을 확인하세요.");
  const exponent = BigInt(match[4] ?? "0") - BigInt((match[3] ?? "").length);
  const digits = `${match[2]}${match[3] ?? ""}`.replace(/^0+/, "");
  if (!digits) return "0";
  const trimmed = digits.replace(/0+$/, "");
  return `${match[1]}${trimmed}e${exponent + BigInt(digits.length - trimmed.length)}`;
}
export function numberFingerprint(value: number | ExactPolicyNumber): string {
  return decimal(value instanceof ExactPolicyNumber ? value.token : JSON.stringify(value));
}
export function parsePolicyJSON(text: string, lossless = false): unknown {
  let at = 0;
  const whitespace = () => {
    while (/[\x20\t\r\n]/.test(text[at] ?? "x")) at++;
  };
  const invalid = () => importProblem("올바른 JSON 한 개를 선택하세요. 원문 오류 내용은 표시하지 않습니다.");
  const string = (): string => {
    const start = at++;
    let escaped = false;
    while (at < text.length) {
      const char = text[at++];
      if (!escaped && char === '"') {
        let result: unknown;
        try {
          result = JSON.parse(text.slice(start, at));
        } catch {
          return invalid();
        }
        if (
          typeof result !== "string" ||
          /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(result)
        )
          return importProblem("짝이 맞지 않는 유니코드 문자는 가져올 수 없습니다.");
        return result;
      }
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
    }
    return invalid();
  };
  const value = (depth: number): unknown => {
    whitespace();
    const char = text[at];
    if (char === "{" || char === "[") {
      if (depth >= policyImportLimits.depth)
        return importProblem("JSON 중첩은 64단계까지 가져올 수 있습니다.");
      at++;
      const array = char === "[";
      const close = array ? "]" : "}";
      const rows: unknown[] = [];
      const fields: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      whitespace();
      if (text[at] === close) {
        at++;
        return array ? rows : fields;
      }
      for (;;) {
        whitespace();
        let key = "";
        if (!array) {
          if (text[at] !== '"') return invalid();
          key = string();
          if (Object.hasOwn(fields, key)) return importProblem("중복 JSON 키는 가져올 수 없습니다.");
          whitespace();
          if (text[at++] !== ":") return invalid();
        }
        const item = value(depth + 1);
        if (array) rows.push(item);
        else fields[key] = item;
        whitespace();
        if (text[at] === close) {
          at++;
          return array ? rows : fields;
        }
        if (text[at++] !== ",") return invalid();
      }
    }
    if (char === '"') return string();
    for (const [literal, parsed] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (text.startsWith(literal, at)) {
        at += literal.length;
        return parsed;
      }
    }
    const token = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(at))?.[0];
    if (!token) return invalid();
    at += token.length;
    // Bound exponent-token processing without changing the submitted value.
    if ((token.split(/[eE]/)[1]?.replace(/^[+-]/, "").length ?? 0) > 8)
      return importProblem("숫자 지수의 표현 범위를 확인하세요.");
    const number = Number(token);
    const safe =
      Number.isFinite(number) &&
      !Object.is(number, -0) &&
      (!Number.isInteger(number) || Number.isSafeInteger(number)) &&
      decimal(token) === decimal(JSON.stringify(number));
    if (safe) return number;
    if (lossless) return new ExactPolicyNumber(token);
    return importProblem("숫자 값이 바뀔 수 있어 가져오기를 중단했습니다. 안전한 숫자 표현으로 확인하세요.");
  };
  const result = value(0);
  whitespace();
  if (at !== text.length) return invalid();
  return result;
}
export function decodePolicyBytes(bytes: ArrayBuffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return importProblem("UTF-8 JSON 파일을 선택하세요.");
  }
}
export function policyFingerprint(value: unknown): string {
  if (typeof value === "number" || value instanceof ExactPolicyNumber) return `n:${numberFingerprint(value)}`;
  if (Array.isArray(value)) return `[${value.map(policyFingerprint).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${policyFingerprint((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}
