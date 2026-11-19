import type { ApiFile } from "@/shared/api/file-endpoint";

/** Offers exact response bytes only while their session and screen still own them. */
export function downloadApiFile(filename: string, file: ApiFile): void {
  file.assertCurrent();
  const blob = new Blob([file.bytes], { type: file.contentType });
  let url: string | undefined;
  let anchor: HTMLAnchorElement | undefined;
  let dispatched = false;
  try {
    file.assertCurrent();
    url = URL.createObjectURL(blob);
    file.assertCurrent();
    anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    file.assertCurrent();
    anchor.click();
    dispatched = true;
  } finally {
    anchor?.remove();
    if (url !== undefined) {
      const allocated = url;
      if (dispatched) window.setTimeout(() => URL.revokeObjectURL(allocated), 1_000);
      else URL.revokeObjectURL(allocated);
    }
  }
}
