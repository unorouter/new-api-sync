import YAML, { isMap, isScalar, isSeq, type Document, type Node } from "yaml";

/**
 * Apply a plain JSON object to a parsed YAML `Document` in place, preserving
 * comments on nodes that are still present.
 *
 * Strategy:
 *   - Walk both trees in parallel using path-keyed `setIn` / `deleteIn`
 *   - Scalar changes update the value on the existing Scalar node → any inline
 *     comment attached to that node stays
 *   - Map children recurse per key so nested comments survive
 *   - Seqs can't preserve per-item comments through re-ordering, but the Seq's
 *     own `.comment` / `.commentBefore` (often whole commented-out blocks
 *     after an array, eg disabled providers) are copied onto the replacement
 *   - When a provider-like seq of objects can be aligned by `name`, existing
 *     items are mutated in place so their inner comments stick
 *
 * Returns the mutated document (same reference).
 */
function syncYamlDocument(doc: Document, next: unknown): Document {
  syncNode(doc, [], next);
  return doc;
}

type CommentFields = {
  comment?: string;
  commentBefore?: string;
  spaceBefore?: boolean;
};

function captureComments(node: unknown): CommentFields {
  if (!node || typeof node !== "object") return {};
  const n = node as Partial<CommentFields>;
  return {
    comment: n.comment,
    commentBefore: n.commentBefore,
    spaceBefore: n.spaceBefore,
  };
}

function restoreComments(
  node: Node | null | undefined,
  fields: CommentFields,
): void {
  if (!node) return;
  const target = node as Partial<CommentFields>;
  if (fields.comment !== undefined) target.comment = fields.comment;
  if (fields.commentBefore !== undefined)
    target.commentBefore = fields.commentBefore;
  if (fields.spaceBefore !== undefined) target.spaceBefore = fields.spaceBefore;
}

function syncNode(
  doc: Document,
  path: (string | number)[],
  next: unknown,
): void {
  if (next === undefined || next === null) {
    if (path.length > 0) doc.deleteIn(path);
    return;
  }

  const existing = path.length === 0 ? doc.contents : doc.getIn(path, true);

  if (Array.isArray(next)) {
    syncArray(doc, path, next, existing);
    return;
  }

  if (typeof next === "object") {
    if (!isMap(existing)) {
      doc.setIn(path, next);
      return;
    }
    const nextKeys = new Set(Object.keys(next as Record<string, unknown>));
    for (const item of [...existing.items]) {
      const key = isScalar(item.key)
        ? String(item.key.value)
        : String(item.key);
      if (!nextKeys.has(key)) {
        doc.deleteIn([...path, key]);
      }
    }
    for (const [key, value] of Object.entries(
      next as Record<string, unknown>,
    )) {
      syncNode(doc, [...path, key], value);
    }
    return;
  }

  // Scalar.
  if (isScalar(existing)) {
    existing.value = next;
    return;
  }
  doc.setIn(path, next);
}

/**
 * Write an array at `path`. Tries to align existing items by `name` (the
 * common provider pattern) so inner comments on unchanged fields stay, and
 * always restores Seq-level comments (trailing / before) that would otherwise
 * vanish on a wholesale replacement.
 */
function syncArray(
  doc: Document,
  path: (string | number)[],
  next: unknown[],
  existing: unknown,
): void {
  if (isSeq(existing) && canAlignByName(next)) {
    // Align by `name`. Items that already exist are mutated in place; new ones
    // are appended; removed ones are dropped.
    const byName = new Map<string, number>();
    existing.items.forEach((item, idx) => {
      const name = tryReadName(item);
      if (name !== null) byName.set(name, idx);
    });
    const kept = new Set<number>();
    // First pass: update existing items in place by recursing with syncNode
    next.forEach((entry, i) => {
      const name = (entry as { name: string }).name;
      const existingIdx = byName.get(name);
      if (existingIdx !== undefined) {
        syncNode(doc, [...path, existingIdx], entry);
        kept.add(existingIdx);
      }
    });
    // Remove old items that aren't in `next` (back-to-front to keep indices stable).
    for (let i = existing.items.length - 1; i >= 0; i--) {
      if (!kept.has(i)) doc.deleteIn([...path, i]);
    }
    // Append new items that weren't in the existing set.
    const existingNames = new Set<string>();
    existing.items.forEach((item) => {
      const name = tryReadName(item);
      if (name !== null) existingNames.add(name);
    });
    for (const entry of next) {
      const name = (entry as { name: string }).name;
      if (!existingNames.has(name)) {
        doc.addIn(path, entry);
      }
    }
    return;
  }

  // Simple replacement — preserve the Seq's own comments.
  const previousComments = isSeq(existing) ? captureComments(existing) : {};
  doc.setIn(path, next);
  if (Object.keys(previousComments).length > 0) {
    const replacement =
      path.length === 0 ? doc.contents : doc.getIn(path, true);
    restoreComments(replacement as Node | null, previousComments);
  }
}

function canAlignByName(arr: unknown[]): boolean {
  if (arr.length === 0) return false;
  return arr.every(
    (item) =>
      item !== null &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      typeof (item as { name?: unknown }).name === "string",
  );
}

function tryReadName(item: unknown): string | null {
  if (!item || typeof item !== "object") return null;
  if (isMap(item)) {
    const name = item.get("name");
    return typeof name === "string" ? name : null;
  }
  const rec = item as { name?: unknown };
  return typeof rec.name === "string" ? rec.name : null;
}

/** Parse + sync + stringify, preserving comments on untouched nodes. */
export function stringifyWithComments(
  previousText: string,
  next: unknown,
): string {
  const doc = YAML.parseDocument(previousText);
  syncYamlDocument(doc, next);
  return String(doc);
}
