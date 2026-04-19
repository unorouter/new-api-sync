import { Type as T } from "@sinclair/typebox";

export const PipelineBody = T.Object({
  only: T.Optional(T.Array(T.String(), { default: [] })),
  models: T.Optional(T.Array(T.String(), { default: [] })),
  /** Config name — empty = main config.yml, else config.<name>.yml */
  configName: T.Optional(T.String()),
});

export const CancelBody = T.Object({ id: T.String() });
