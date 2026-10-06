/** Read a discovery response without buffering beyond its byte budget. */
export async function readBody(response: Response, maxBytes: number): Promise<Buffer> {
  if (response.body === null) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw new Error(`Response exceeded ${maxBytes} bytes.`);
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks, bytes);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
