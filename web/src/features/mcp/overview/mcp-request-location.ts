/** Mirrors the existing legacy MCP identifier boundary, not the newer opaque request reference. */
export function validMcpRequestId(id: string): boolean {
  if (!id || !id.trim() || id === "." || id === ".." || /[\p{Cc}/]/u.test(id)) return false;
  try {
    encodeURIComponent(id); // Reject unpaired UTF-16 surrogates before building a path.
    return new TextEncoder().encode(id).length <= 4096;
  } catch {
    return false;
  }
}
