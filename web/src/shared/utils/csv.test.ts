import { describe, expect, it } from "vitest";
import { toCsv } from "./csv";

describe("CSV 수식과 인용 보호", () => {
  it.each([
    "=2+2",
    "+2",
    "-2",
    "@sum(A1)",
    "  =2+2",
    "\uFEFF=2",
    "\u0000=2",
    "\tvalue",
    "\rvalue",
    "\nvalue",
  ])("셀 시작 %j를 실행 가능한 수식으로 남기지 않는다", (value) => {
    const csv = toCsv([value], [{ header: "값", value: (row) => row }]);
    const expected = "'" + value;
    expect(csv).toBe(
      "\uFEFF값\r\n" +
        (/[",\n\r]/u.test(expected) ? '"' + expected.replaceAll('"', '""') + '"' : expected) +
        "\r\n",
    );
  });
  it("쉼표·따옴표·줄바꿈과 BOM·CRLF를 보존한다", () => {
    expect(toCsv(['공개,"이름"\n둘째'], [{ header: "이름", value: (row) => row }])).toBe(
      '\uFEFF이름\r\n"공개,""이름""\n둘째"\r\n',
    );
  });
});
