/**
 * Centralized React Query cache keys.
 *
 * Never use raw string arrays in useQuery/useMutation — always come through here
 * so cache updates (setQueryData, invalidate) hit the correct entries.
 */
export const queryKeys = {
  health: () => ["health"] as const,
  config: () => ["config"] as const,
  runHistory: () => ["run-history"] as const,
  historyRuns: () => ["history", "runs"] as const,
  historyRun: (id: string) => ["history", "runs", id] as const,
  historyKiro: () => ["history", "kiro"] as const,
} as const;
