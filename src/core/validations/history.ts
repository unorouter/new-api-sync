import {
  DeletedDataSchema,
  ErrorResponseSchema,
  successArrayResponse,
  successResponse,
} from "@core/validations/common";
import { Type as T } from "@sinclair/typebox";

const ResultHttpSchema = T.Object({
  pass: T.Boolean(),
  // prettier-ignore
  request: T.Object({ url: T.String(), headers: T.Optional(T.Record(T.String(), T.String())), body: T.Unknown() }),
  response: T.Unknown(),
  responseHeaders: T.Optional(T.Record(T.String(), T.String())),
  error: T.Optional(T.String()),
  status: T.Optional(T.Number()),
  latencyMs: T.Optional(T.Number()),
});

// prettier-ignore
const ResultSchema = T.Object({ provider: T.String(), model: T.String(), cost: T.Union([T.Number(), T.Null()]), http: ResultHttpSchema, stream: T.Union([ResultHttpSchema, T.Null()]), toolCall: T.Union([ResultHttpSchema, T.Null()]), authentic: T.Union([T.Boolean(), T.Null()]), authenticityProbes: T.Optional(T.Array(T.Unknown())) });

// prettier-ignore
const RunSummarySchema = T.Object({ id: T.String(), timestamp: T.String(), size: T.Number(), total: T.Number(), passed: T.Number(), failed: T.Number() });

const ChangeSetSchema = T.Union([
  // prettier-ignore
  T.Object({ created: T.Array(T.String()), updated: T.Array(T.String()), deleted: T.Array(T.String()) }),
  T.Object({ created: T.Number(), updated: T.Number(), deleted: T.Number() }),
]);

// prettier-ignore
const ProviderEntrySchema = T.Object({ testCost: T.Optional(T.Number()), success: T.Optional(T.Boolean()), error: T.Optional(T.String()), channels: T.Optional(ChangeSetSchema), groups: T.Optional(T.Number()), models: T.Optional(T.Number()), tokens: T.Optional(T.Object({ created: T.Number(), existing: T.Number(), deleted: T.Number() })) });

const RunOutcomeSchema = T.Object({
  providers: T.Object({ passed: T.Number(), total: T.Number() }),
  channels: ChangeSetSchema,
  models: T.Intersect([
    ChangeSetSchema,
    T.Object({ orphansDeleted: T.Number() }),
  ]),
  options: T.Optional(T.Object({ updated: T.Array(T.String()) })),
  optionsUpdated: T.Optional(T.Number()),
  elapsedSeconds: T.Number(),
  success: T.Boolean(),
  // prettier-ignore
  errors: T.Optional(T.Array(T.Object({ phase: T.String(), key: T.String(), message: T.String() }))),
});

const PricingGateSchema = T.Object({
  exposed: T.String(),
  vote: T.Object({
    // prettier-ignore
    candidates: T.Array(T.Object({ source: T.String(), matchedKey: T.Optional(T.String()), modelRatio: T.Optional(T.Number()), completionRatio: T.Optional(T.Number()), inputUsdPerM: T.Optional(T.Number()), outputUsdPerM: T.Optional(T.Number()) })),
    cluster: T.Union([
      // prettier-ignore
      T.Object({ members: T.Array(T.String()), modelRatio: T.Number(), completionRatio: T.Number(), inputUsdPerM: T.Number(), outputUsdPerM: T.Number() }),
      T.Null(),
    ]),
    decision: T.String(),
  }),
});

const OpenRouterEndpointsSchema = T.Object({
  id: T.String(),
  // prettier-ignore
  endpoints: T.Array(T.Object({ provider: T.String(), quantization: T.Optional(T.String()), prompt: T.Number(), completion: T.Number(), discount: T.Number(), effectivePrompt: T.Number(), effectiveCompletion: T.Number() })),
  // prettier-ignore
  picked: T.Optional(T.Object({ provider: T.String(), promptUsd: T.Number(), completionUsd: T.Number() })),
});

// prettier-ignore
const RunDetailSchema = T.Object({ id: T.String(), timestamp: T.String(), results: T.Array(ResultSchema), summary: T.Optional(RunOutcomeSchema), providers: T.Optional(T.Record(T.String(), ProviderEntrySchema)), pricingGate: T.Optional(T.Array(PricingGateSchema)), openrouterEndpoints: T.Optional(T.Array(OpenRouterEndpointsSchema)) });

// prettier-ignore
const AuthenticityEntrySchema = T.Object({ key: T.String(), provider: T.String(), group: T.String(), model: T.String(), since: T.String(), reason: T.String() });

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
