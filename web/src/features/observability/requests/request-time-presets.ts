export const requestTimePresets = [
  { label: "최근 1시간", hours: 1 },
  { label: "최근 24시간", hours: 24 },
  { label: "최근 7일", hours: 168 },
  { label: "최근 30일", hours: 720 },
] as const;
export type RequestTimePreset = (typeof requestTimePresets)[number];

export function requestPresetRange(preset: RequestTimePreset, now = Date.now()) {
  return {
    from: new Date(now - preset.hours * 3_600_000).toISOString(),
    to: new Date(now).toISOString(),
  };
}
