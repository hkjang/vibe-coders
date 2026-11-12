/** Preserve controls embedded in cells for both ordinary clicks and row menus. */
export function interactiveRowTarget(
  target: EventTarget | null,
  row: Element,
  allowRowAction = false,
): boolean {
  if (!(target instanceof Element)) return false;
  const control = target.closest(
    'a,button,input,select,textarea,label,summary,[contenteditable],[role="button"],[role="link"],[tabindex]',
  );
  return Boolean(
    control && row.contains(control) && (!allowRowAction || !control.hasAttribute("data-table-row-action")),
  );
}
