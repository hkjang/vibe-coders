export const uiLabels = {
  previewReadOnly: "읽기 전용 미리보기",
  readOnly: "읽기 전용",
  legacyBridge: "기존 화면 연결",
  legacyAdmin: "기존 관리자 화면",
  legacyAdministrator: "기존 관리자",
  nextConsole: "차세대 콘솔",
  console: "관리 콘솔",
} as const;

export const migrationStatusLabels = {
  hidden: "숨김",
  legacy: "기존 화면",
  preview_read_only: "읽기 전용",
  preview: "미리보기",
  stable: "안정",
  deprecated: "지원 종료 예정",
  retired: "종료",
} as const;

export const healthStatusLabels = {
  healthy: "정상",
  degraded: "저하",
  disconnected: "연결 끊김",
  checking: "확인 중",
  critical: "심각",
  attention: "주의",
  normal: "정상",
  safe: "안전",
  dropped: "유실 발생",
  unavailable: "확인 불가",
  partialFailure: "일부 실패",
  unknown: "상태 미확인",
} as const;

export const preferenceLabels = {
  theme: "테마",
  light: "밝게",
  dark: "어둡게",
  system: "시스템 설정",
  density: "정보 밀도",
  compact: "조밀하게",
  default: "기본",
  comfortable: "여유롭게",
} as const;

export const riskLevelLabels = {
  low: "낮음",
  medium: "보통",
  high: "높음",
  critical: "심각",
} as const;
