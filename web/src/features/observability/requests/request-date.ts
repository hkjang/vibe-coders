const defaultRequestTimeZone = "Asia/Seoul";

export function formatRequestDate(
  value: string,
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "확인 불가";

  try {
    return new Intl.DateTimeFormat("ko-KR", {
      ...options,
      timeZone: timeZone || defaultRequestTimeZone,
    }).format(date);
  } catch {
    return "확인 불가";
  }
}
