const maximumDateTimestamp = 8_640_000_000_000_000;

const modelDateFormatter = new Intl.DateTimeFormat("ko-KR", {
  dateStyle: "medium",
  timeStyle: "medium",
});

export function formatModelDate(value: string | number | null): string {
  if (value === null) return "정보 없음";
  const timestamp = typeof value === "number" ? value * 1_000 : Date.parse(value);
  if (!Number.isFinite(timestamp) || Math.abs(timestamp) > maximumDateTimestamp) return String(value);
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return String(value);
  return modelDateFormatter.format(date);
}
