import type { ConfigSchemaType } from "@core/validations/config";
import type { FieldPath } from "react-hook-form";

/**
 * Build a typed RHF field path for a provider field. TypeBox's discriminated
 * union can't be narrowed by path alone, so most provider field names have to
 * be cast through this helper. The template literal preserves array-index
 * safety in RHF's internal Path type.
 */
export function providerPath<K extends string>(
  i: number,
  k: K,
): FieldPath<ConfigSchemaType> {
  return `providers.${i}.${k}` as FieldPath<ConfigSchemaType>;
}
