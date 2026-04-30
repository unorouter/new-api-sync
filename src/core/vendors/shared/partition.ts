import { inferVendorFromModelName } from "@core/catalog/constants/vendor-matchers";

/**
 * Group items by inferred vendor. Items whose name doesn't match any vendor
 * matcher land in the `fallback` bucket.
 *
 * `getName` extracts the model-name string used for vendor inference. For
 * `string[]` inputs that's the identity function; for OfferModel-like inputs
 * it's `m => m.exposed`.
 *
 * Each provider chooses its own fallback string (`"unknown"` for newapi,
 * `"other"` for nvidia/openrouter) — these strings flow into channel-name
 * suffixes downstream, so the call sites must keep their existing values.
 */
export function partitionByVendor<T>(
  items: T[],
  getName: (item: T) => string,
  fallback: string,
): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const vendor = inferVendorFromModelName(getName(item)) ?? fallback;
    let arr = out.get(vendor);
    if (!arr) {
      arr = [];
      out.set(vendor, arr);
    }
    arr.push(item);
  }
  return out;
}
