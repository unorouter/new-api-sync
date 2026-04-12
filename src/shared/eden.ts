/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-empty-object-type */

/**
 * Extracts params from an Eden Treaty route function.
 */
type ExtractParams<TRoute> = TRoute extends (...args: any[]) => any
  ? Parameters<TRoute>[0]
  : {};

type ResolveMethod<TRoute, TMethod extends string> = TRoute extends (
  ...args: any[]
) => any
  ? TMethod extends keyof ReturnType<TRoute>
    ? ReturnType<TRoute>[TMethod]
    : TMethod extends keyof TRoute
      ? TRoute[TMethod]
      : never
  : TMethod extends keyof TRoute
    ? TRoute[TMethod]
    : never;

type IsOptions<T> = [T] extends [never]
  ? false
  : "query" extends keyof NonNullable<T>
    ? true
    : "headers" extends keyof NonNullable<T>
      ? true
      : "fetch" extends keyof NonNullable<T>
        ? true
        : "throwHttpError" extends keyof NonNullable<T>
          ? true
          : false;

type ExtractQuery<T> = "query" extends keyof NonNullable<T>
  ? undefined extends T
    ? { query?: NonNullable<T>["query"] }
    : { query: NonNullable<T>["query"] }
  : {};

type ExtractBodyAndQuery<TFn> = TFn extends (...args: any[]) => any
  ? 0 extends keyof Parameters<TFn>
    ? IsOptions<Parameters<TFn>[0]> extends true
      ? ExtractQuery<Parameters<TFn>[0]>
      : [unknown] extends [Parameters<TFn>[0]]
        ? {}
        : { body: NonNullable<Parameters<TFn>[0]> } & ExtractQuery<
            Parameters<TFn>[1]
          >
    : {}
  : {};

type ShouldIncludeParams<TRoute, TMethod extends string> = TRoute extends (
  ...args: any[]
) => any
  ? TMethod extends keyof ReturnType<TRoute>
    ? true
    : false
  : false;

export type EdenArgs<TRoute, TMethod extends string> = (ShouldIncludeParams<
  TRoute,
  TMethod
> extends true
  ? ExtractParams<TRoute>
  : {}) &
  ExtractBodyAndQuery<ResolveMethod<TRoute, TMethod>>;

export type EdenQuery<TRoute, TMethod extends string = "get"> =
  EdenArgs<TRoute, TMethod> extends { query?: infer Q } ? Q : never;

export type EdenResponse<TRoute, TMethod extends string = "get"> =
  ResolveMethod<TRoute, TMethod> extends (...args: any[]) => any
    ? Awaited<ReturnType<ResolveMethod<TRoute, TMethod>>> extends {
        data: infer D;
      }
      ? NonNullable<D> extends { success: boolean; data: infer Inner }
        ? Inner
        : NonNullable<D>
      : never
    : never;

export type ExtractData<T> = T extends { data: infer D } ? NonNullable<D> : never;

export type ExcludeVoid<T> = T extends void ? never : T;

export type UnwrapApiResponse<T> = ExcludeVoid<
  NonNullable<T extends { success: boolean; data: infer D } ? D : T>
>;
