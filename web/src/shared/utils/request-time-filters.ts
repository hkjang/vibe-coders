export const invalidRequestDateTimeMessage =
  "날짜와 시각을 YYYY-MM-DD, 로컬 시각 또는 RFC3339 형식으로 입력하세요.";
export const invalidRequestTimeZoneMessage = "올바른 IANA 시간대를 입력하세요. 예: Asia/Seoul";
export const invalidRequestTimeRangeMessage = "종료 시각은 시작 시각보다 빠를 수 없습니다.";

const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/u;
const localDateTimePattern = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/u;
const rfc3339Pattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/u;

interface ParsedRequestDateTime {
  comparable: number;
}

export interface RequestTimeFilterValues {
  from?: string;
  to?: string;
  tz?: string;
}

export interface RequestTimeFilterError {
  field: "from" | "to" | "tz";
  message: string;
}

function leapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function validDateTimeParts(parts: readonly number[]): boolean {
  const [year = -1, month = -1, day = -1, hour = 0, minute = 0, second = 0] = parts;
  const days = [31, leapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return (
    year >= 0 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= (days[month - 1] ?? 0) &&
    hour >= 0 &&
    hour <= 23 &&
    minute >= 0 &&
    minute <= 59 &&
    second >= 0 &&
    second <= 59
  );
}

function utcFromParts(parts: readonly number[], endOfDay: boolean): number {
  const [
    year = 0,
    month = 1,
    day = 1,
    hour = endOfDay ? 23 : 0,
    minute = endOfDay ? 59 : 0,
    second = endOfDay ? 59 : 0,
  ] = parts;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, endOfDay ? 999 : 0);
  return date.getTime();
}

function zonedParts(timestamp: number, timeZone: string): number[] | undefined {
  try {
    const parts = new Intl.DateTimeFormat("en-CA-u-ca-gregory-nu-latn", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(timestamp);
    const value = (type: Intl.DateTimeFormatPartTypes): number =>
      Number(parts.find((part) => part.type === type)?.value);
    const result = [
      value("year"),
      value("month"),
      value("day"),
      value("hour"),
      value("minute"),
      value("second"),
    ];
    return result.every(Number.isInteger) ? result : undefined;
  } catch {
    return undefined;
  }
}

function localTimeToEpoch(parts: readonly number[], endOfDay: boolean, timeZone: string): number | undefined {
  const target = utcFromParts(parts, endOfDay);
  let candidate = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const observedParts = zonedParts(candidate, timeZone);
    if (!observedParts) return undefined;
    const observed = utcFromParts(observedParts, endOfDay);
    candidate += target - observed;
  }
  const expected = [...parts];
  while (expected.length < 6) {
    expected.push(endOfDay ? (expected.length === 3 ? 23 : 59) : 0);
  }
  const observed = zonedParts(candidate, timeZone);
  return observed?.every((part, index) => part === expected[index]) ? candidate : undefined;
}

function parseRequestDateTime(
  value: string,
  endOfDay: boolean,
  timeZone: string,
): ParsedRequestDateTime | undefined {
  const date = datePattern.exec(value);
  if (date) {
    const parts = date.slice(1).map(Number);
    if (!validDateTimeParts(parts)) return undefined;
    const comparable = localTimeToEpoch(parts, endOfDay, timeZone);
    return comparable === undefined ? undefined : { comparable };
  }

  const local = localDateTimePattern.exec(value);
  if (local) {
    const parts = local
      .slice(1)
      .filter((part) => part !== undefined)
      .map(Number);
    if (!validDateTimeParts(parts)) return undefined;
    const comparable = localTimeToEpoch(parts, false, timeZone);
    return comparable === undefined ? undefined : { comparable };
  }

  const rfc3339 = rfc3339Pattern.exec(value);
  if (!rfc3339) return undefined;
  const parts = rfc3339.slice(1, 7).map(Number);
  const offset = rfc3339[7] ?? "";
  if (!validDateTimeParts(parts)) return undefined;
  if (offset !== "Z") {
    const [offsetHour, offsetMinute] = offset.slice(1).split(":").map(Number);
    if ((offsetHour ?? 24) > 23 || (offsetMinute ?? 60) > 59) return undefined;
  }
  const comparable = Date.parse(value);
  return Number.isFinite(comparable) ? { comparable } : undefined;
}

export function isValidRequestDateTime(value: string): boolean {
  return value === "" || parseRequestDateTime(value, false, "UTC") !== undefined;
}

export function isValidRequestTimeZone(value: string): boolean {
  if (value === "" || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat("ko-KR", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

export function validateRequestTimeFilters(
  values: RequestTimeFilterValues,
): RequestTimeFilterError | undefined {
  const timeZone = values.tz?.trim() || "Asia/Seoul";
  if (!isValidRequestTimeZone(timeZone)) {
    return { field: "tz", message: invalidRequestTimeZoneMessage };
  }

  const fromValue = values.from?.trim() ?? "";
  const toValue = values.to?.trim() ?? "";
  const from = fromValue ? parseRequestDateTime(fromValue, false, timeZone) : undefined;
  if (fromValue && !from) return { field: "from", message: invalidRequestDateTimeMessage };
  const to = toValue ? parseRequestDateTime(toValue, true, timeZone) : undefined;
  if (toValue && !to) return { field: "to", message: invalidRequestDateTimeMessage };
  if (from && to && from.comparable > to.comparable) {
    return { field: "to", message: invalidRequestTimeRangeMessage };
  }
  return undefined;
}
