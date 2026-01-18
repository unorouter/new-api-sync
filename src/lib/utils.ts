export function logInfo(message: string) {
  console.log(`${new Date().toISOString()} [INFO] ${message}`);
}

/**
 * Removes Chinese characters from a string, keeping only ASCII alphanumeric,
 * hyphens, and underscores. Collapses multiple hyphens into one.
 */
export function sanitizeGroupName(name: string): string {
  return name
    .replace(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function logError(message: string) {
  console.log(`${new Date().toISOString()} [ERROR] ${message}`);
}

export async function fetchPaginated<
  T,
  D extends { success: boolean } = { success: boolean },
>(
  url: string,
  headers: Record<string, string>,
  extractItems: (data: D) => T[],
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
