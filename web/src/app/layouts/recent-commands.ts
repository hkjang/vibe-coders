/** Only local console commands; never retain search text, resource IDs or URLs. */
const commandIds = new Set([
  "action:refresh",
  "action:theme",
  "action:density",
  "action:refresh-interval",
  "action:sidebar",
  "action:shortcuts",
]);

export function rememberCommand(history: readonly string[], id: string): string[] {
  if (!commandIds.has(id)) return [...history];
  return [...new Set([id, ...history.filter((item) => commandIds.has(item))])].slice(0, 5);
}
