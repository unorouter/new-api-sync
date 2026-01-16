export function logInfo(message: string) {
  console.log(`${new Date().toISOString()} [INFO] ${message}`);
}

export function logError(message: string) {
  console.log(`${new Date().toISOString()} [ERROR] ${message}`);
}

export async function fetchPaginated<T, D extends { success: boolean } = { success: boolean }>(
  url: string,
  headers: Record<string, string>,
  extractItems: (data: D) => T[]
): Promise<T[]> {
  const all: T[] = [];
  let page = 0;
  while (true) {
    const response = await fetch(`${url}?p=${page}&page_size=100`, { headers });
    if (!response.ok) throw new Error(`Failed to fetch: ${response.status}`);
    const data = (await response.json()) as D;
    if (!data.success) throw new Error("API returned success: false");
    const items = extractItems(data);
    all.push(...items);
    if (items.length < 100) break;
    page++;
  }
  return all;
}

export function ensureSkPrefix(key: string): string {
  return key.startsWith("sk-") ? key : `sk-${key}`;
}
