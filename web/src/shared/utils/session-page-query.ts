export function validSessionPageValue(key: string, values: readonly string[]): boolean {
  if (values.length !== 1) return false;
  const value = values[0] ?? "";
  if (key === "page_size") return ["25", "50", "100"].includes(value);
  if (key === "offset") return /^(0|[1-9]\d{0,6})$/u.test(value) && Number(value) <= 1_000_000;
  return false;
}
