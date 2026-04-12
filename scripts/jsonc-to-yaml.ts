/**
 * One-shot migrator: JSONC -> YAML, preserving blank-line grouping and comments.
 *
 * Usage: bun scripts/jsonc-to-yaml.ts <input.jsonc> <output.yml>
 */
import YAML from "yaml";
import { createScanner } from "jsonc-parser";
import type { YAMLMap, YAMLSeq, Pair, Scalar } from "yaml";

// jsonc-parser exports SyntaxKind as a const enum; avoid importing it under
// verbatimModuleSyntax and just use the numeric values directly.
const LINE_COMMENT_TRIVIA = 12;
const EOF = 17;

const TYPE_LABELS: Record<string, string> = {
  newapi: "new-api upstream",
  direct: "Direct vendor API",
  sub2api: "sub2api",
  nvidia: "NVIDIA NIM",
};

interface MappingGroup {
  keys: string[];
}

interface Extracted {
  mappingGroups: Record<string, MappingGroup[]>;
  disabledProviders: unknown[];
}

function extract(text: string): Extracted {
  const result: Extracted = {
    mappingGroups: {},
    disabledProviders: [],
  };

  // Blank-line groups inside modelMapping
  const mapRe = /"(modelMapping)"\s*:\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = mapRe.exec(text)) !== null) {
    const field = m[1];
    if (!field) continue;
    const start = m.index + m[0].length;
    let depth = 1;
    let i = start;
    let inStr = false;
    let esc = false;
    while (i < text.length && depth > 0) {
      const c = text[i];
      if (esc) {
        esc = false;
        i++;
        continue;
      }
      if (c === "\\") {
        esc = true;
        i++;
        continue;
      }
      if (c === '"') {
        inStr = !inStr;
        i++;
        continue;
      }
      if (!inStr) {
        if (c === "{") depth++;
        else if (c === "}") depth--;
      }
      i++;
    }
    const body = text.slice(start, i - 1);
    const lines = body.split("\n");
    const groups: MappingGroup[] = [{ keys: [] }];
    const pairRe = /^\s*"([^"]+)"\s*:\s*"[^"]+"\s*,?\s*$/;
    for (const line of lines) {
      const current = groups[groups.length - 1];
      if (!current) continue;
      if (line.trim() === "") {
        if (current.keys.length > 0) groups.push({ keys: [] });
      } else {
        const pm = line.match(pairRe);
        if (pm && pm[1]) current.keys.push(pm[1]);
      }
    }
    result.mappingGroups[field] = groups.filter((g) => g.keys.length > 0);
  }

  // Disabled provider blocks via scanner
  const scanner = createScanner(text, false);
  const commentLines: string[] = [];
  let kind = scanner.scan();
  while (kind !== EOF) {
    if (kind === LINE_COMMENT_TRIVIA) {
      const raw = scanner.getTokenValue();
      commentLines.push(raw.replace(/^\s*\/\/\s?/, ""));
    }
    kind = scanner.scan();
  }
  const blocks: string[] = [];
  let buf: string[] = [];
  let inBlock = false;
  for (const line of commentLines) {
    const trimmed = line.trim();
    if (!inBlock && trimmed === "{") {
      inBlock = true;
      buf = [line];
    } else if (inBlock) {
      buf.push(line);
      if (trimmed === "}" || trimmed === "},") {
        blocks.push(buf.join("\n"));
        buf = [];
        inBlock = false;
      }
    }
  }
  for (const raw of blocks) {
    const cleaned = raw.trim().replace(/,\s*$/, "");
    try {
      result.disabledProviders.push(Bun.JSONC.parse(cleaned));
    } catch {
      /* skip unparseable */
    }
  }

  return result;
}

async function emitAsync(jsoncPath: string, ymlPath: string): Promise<void> {
  const text = await Bun.file(jsoncPath).text();
  const config = Bun.JSONC.parse(text) as Record<string, unknown>;
  const extracted = extract(text);

  const doc = new YAML.Document(config);

  // Apply blank-line groups to modelMapping
  for (const [field, groups] of Object.entries(extracted.mappingGroups)) {
    const node = doc.get(field, true) as YAMLMap | undefined;
    if (!node || !("items" in node)) continue;
    const keyToGroup = new Map<string, number>();
    groups.forEach((g, idx) => g.keys.forEach((k) => keyToGroup.set(k, idx)));
    let prevGroup = -1;
    for (const pair of node.items as Pair[]) {
      const keyNode = pair.key as Scalar;
      const keyStr = String(keyNode?.value ?? "");
      const g = keyToGroup.get(keyStr);
      if (g !== undefined && g !== prevGroup && prevGroup !== -1) {
        keyNode.spaceBefore = true;
      }
      if (g !== undefined) prevGroup = g;
    }
  }

  // Group providers by type with separator comments and blank lines
  const providersNode = doc.get("providers", true) as YAMLSeq | undefined;
  if (providersNode && "items" in providersNode) {
    const items = (providersNode.items as YAMLMap[]).slice();
    const byType: Record<string, YAMLMap[]> = {};
    for (const item of items) {
      const typeNode = item.get("type", true) as Scalar | undefined;
      const t = String(typeNode?.value ?? "unknown");
      (byType[t] ??= []).push(item);
    }
    const newItems: YAMLMap[] = [];
    let first = true;
    for (const type of Object.keys(byType)) {
      const label = TYPE_LABELS[type] ?? type;
      const group = byType[type] ?? [];
      for (let i = 0; i < group.length; i++) {
        const node = group[i];
        if (!node) continue;
        if (i === 0) {
          node.commentBefore = ` \u2500\u2500 ${label} \u2500\u2500`;
          if (!first) node.spaceBefore = true;
        } else {
          node.spaceBefore = true;
        }
        newItems.push(node);
      }
      first = false;
    }
    providersNode.items = newItems;

    // Disabled providers as a trailing comment
    if (extracted.disabledProviders.length > 0) {
      const snippet = YAML.stringify(extracted.disabledProviders, {
        indent: 2,
        lineWidth: 120,
      });
      const commented =
        " disabled providers (uncomment to enable)\n" +
        snippet
          .trimEnd()
          .split("\n")
          .map((l) => " " + l)
          .join("\n");
      providersNode.comment = commented;
    }
  }

  const yml = doc.toString({ indent: 2, lineWidth: 120 });
  await Bun.write(ymlPath, yml);
  console.log("wrote", ymlPath);
}

const input = process.argv[2];
const output = process.argv[3];
if (!input || !output) {
  console.error("Usage: bun scripts/jsonc-to-yaml.ts <input.jsonc> <output.yml>");
  process.exit(1);
}
await emitAsync(input, output);
