const utf8Encoder = new TextEncoder();

export function utf8ByteLength(value: string): number {
  return utf8Encoder.encode(value).byteLength;
}

export function fitsUTF8Bytes(value: string, maximumBytes: number): boolean {
  return utf8ByteLength(value) <= maximumBytes;
}
