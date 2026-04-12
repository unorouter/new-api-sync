import { Type as T } from "@sinclair/typebox";

/** Shared envelope for `{ success: false, message: string }` error responses. */
export const ErrorResponseSchema = T.Object({
  success: T.Literal(false),
  message: T.String(),
});

/** Helper: `{ success: true, data: <schema> }`. */
export const successResponse = <S extends ReturnType<typeof T.Object>>(data: S) =>
  T.Object({
    success: T.Literal(true),
    data,
  });

/** Helper: `{ success: true, data: T.Array(<schema>) }`. */
export const successArrayResponse = <S extends ReturnType<typeof T.Object>>(
  item: S,
) =>
  T.Object({
    success: T.Literal(true),
    data: T.Array(item),
  });

export const DeletedDataSchema = T.Object({ deleted: T.String() });
