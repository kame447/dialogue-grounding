export function randomId(prefix: string): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `${prefix}-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export function randomSeed(): number {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0];
}
