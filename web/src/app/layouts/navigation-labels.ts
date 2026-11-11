export const navigationLabels = {
  favorites: "즐겨찾기",
  manage: "즐겨찾기 관리",
  description: "이 브라우저에 자주 쓰는 메뉴를 저장합니다. 변경한 순서는 바로 반영됩니다.",
  empty: "즐겨찾기가 없습니다. 화면 상단의 별 버튼으로 현재 메뉴를 추가하세요.",
  clear: "즐겨찾기 전체 해제",
  recent: "최근 방문 화면",
  clearRecent: "최근 화면 기록 지우기",
  emptyRecent: "최근 방문한 화면이 없습니다.",
  add: (title: string) => `${title} 즐겨찾기에 추가`,
  remove: (title: string) => `${title} 즐겨찾기 해제`,
  up: (title: string) => `${title} 위로 이동`,
  down: (title: string) => `${title} 아래로 이동`,
} as const;
