import {
  DeletedDataSchema,
  ErrorResponseSchema,
  successResponse,
} from "@core/validations/common";
import { ConfigSchema } from "@core/validations/config";
import { Type as T } from "@sinclair/typebox";

export const ConfigFileSchema = T.Object({
  name: T.String(),
  path: T.String(),
  size: T.Number(),
});

export const ConfigQuerySchema = T.Object({ name: T.Optional(T.String()) });

export const ConfigNameParamsSchema = T.Object({ name: T.String() });

const ConfigDataSchema = T.Object({
  name: T.String(),
  path: T.String(),
  config: ConfigSchema,
});

export const ConfigGetResponseSchema = successResponse(ConfigDataSchema);

export const ConfigPutBodySchema = T.Object({
  config: ConfigSchema,
});

export const ConfigPutResponseSchema = {
  200: successResponse(ConfigDataSchema),
  400: ErrorResponseSchema,
};

export const ConfigCreateBodySchema = T.Object({
  name: T.String({ minLength: 1, pattern: "^[a-zA-Z0-9_-]+$" }),
  /** Optional: clone the body from this existing config name. Empty string = main. */
  fromName: T.Optional(T.String()),
});

export const ConfigFilesListResponseSchema = T.Object({
  success: T.Literal(true),
  data: T.Array(ConfigFileSchema),
});

export const ConfigCreateResponseSchema = {
  200: successResponse(ConfigFileSchema),
  400: ErrorResponseSchema,
};

export const ConfigDeleteResponseSchema = {
  200: successResponse(DeletedDataSchema),
  400: ErrorResponseSchema,
  404: ErrorResponseSchema,
};

export const ConfigGetResponsesSchema = {
  200: ConfigGetResponseSchema,
  404: ErrorResponseSchema,
};

export const ConfigPutResponsesSchema = {
  ...ConfigPutResponseSchema,
  404: ErrorResponseSchema,
};
