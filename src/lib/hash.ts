export async function sha1Hex(input: string): Promise<string> {
  const buffer = new TextEncoder().encode(input)
  const hash = await crypto.subtle.digest('SHA-1', buffer)
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('')
}
