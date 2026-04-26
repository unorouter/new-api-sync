import {
  DeletedDataSchema,
  ErrorResponseSchema,
  successArrayResponse,
  successResponse,
} from "@core/validations/common";
import { Type as T } from "@sinclair/typebox";

const ResultHttpSchema = T.Object({
  pass: T.Boolean(),
  request: T.Object({
    url: T.String(),
    headers: T.Optional(T.Record(T.String(), T.String())),
    body: T.Unknown(),
  }),
  response: T.Unknown(),
  responseHeaders: T.Optional(T.Record(T.String(), T.String())),
  error: T.Optional(T.String()),
  status: T.Optional(T.Number()),
  latencyMs: T.Optional(T.Number()),
});

export const ResultSchema = T.Object({
  provider: T.String(),
  model: T.String(),
  cost: T.Union([T.Number(), T.Null()]),
  http: ResultHttpSchema,
  stream: T.Union([ResultHttpSchema, T.Null()]),
  toolCall: T.Union([ResultHttpSchema, T.Null()]),
  authentic: T.Union([T.Boolean(), T.Null()]),
  authenticityProbes: T.Optional(T.Array(T.Unknown())),
});

export const RunSummarySchema = T.Object({
  id: T.String(),
  timestamp: T.String(),
  size: T.Number(),
  total: T.Number(),
  passed: T.Number(),
  failed: T.Number(),
});

export const RunDetailSchema = T.Object({
  id: T.String(),
  timestamp: T.String(),
  results: T.Array(ResultSchema),
});

export const AuthenticityEntrySchema = T.Object({
  key: T.String(),
  provider: T.String(),
  group: T.String(),
  model: T.String(),
  since: T.String(),
  reason: T.String(),
});

export const RunsListResponseSchema = successArrayResponse(RunSummarySchema);

export const RunIdParamsSchema = T.Object({ id: T.String() });

export const RunDetailResponsesSchema = {
  200: successResponse(RunDetailSchema),
  404: ErrorResponseSchema,
};

export const AuthenticityListResponseSchema = successArrayResponse(
  AuthenticityEntrySchema,
);

export const AuthenticityKeyParamsSchema = T.Object({ key: T.String() });

export const AuthenticityDeleteResponsesSchema = {
  200: successResponse(DeletedDataSchema),
  404: ErrorResponseSchema,
};
