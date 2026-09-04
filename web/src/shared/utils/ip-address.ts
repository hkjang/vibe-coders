const decimalIPv4Part = /^(?:0|[1-9][0-9]{0,2})$/u;

export function isValidIPAddress(value: string): boolean {
  const candidate = value.trim();
  if (candidate === "unknown") return true;
  if (candidate === "" || candidate.length > 128) return false;
  if (!candidate.includes(":")) {
    const parts = candidate.split(".");
    return parts.length === 4 && parts.every((part) => decimalIPv4Part.test(part) && Number(part) <= 255);
  }
  if (candidate.includes("%")) return false;
  try {
    const parsed = new URL(`http://[${candidate}]/`);
    return parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]");
  } catch {
    return false;
  }
}
