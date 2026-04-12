import type { TypeCompiler } from "@sinclair/typebox/compiler";
import {
  DefaultErrorFunction,
  SetErrorFunction,
} from "@sinclair/typebox/errors";
import type { Static, TSchema } from "@sinclair/typebox/type";

SetErrorFunction((error) => {
  if (typeof error.schema.error === "string") return error.schema.error;
  return DefaultErrorFunction(error);
});

/**
 * Validate `value` against a compiled TypeBox checker. Returns a discriminated
 * union so callers can branch without throwing. Used by forms for live
 * `isValid` indicators driven by `form.watch()`.
 */
export function safeParse<T extends TSchema>(
  checker: ReturnType<typeof TypeCompiler.Compile<T>>,
  value: Partial<Static<T>>,
):
  | { success: true; data: Static<T> }
  | { success: false; errors: { message: string }[] } {
  if (checker.Check(value)) {
    return { success: true, data: value as Static<T> };
  }
  return {
    success: false,
    errors: Array.from(checker.Errors(value)).map((error) => ({
      message: error.message,
    })),
  };
}
