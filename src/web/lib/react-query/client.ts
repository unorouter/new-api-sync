import { QueryClient } from "@tanstack/react-query";

export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: false,
        staleTime: 10_000,
        retry: 1,
      },
    },
  });
}

let browserQueryClient: QueryClient | undefined;

export default function getQueryClient(): QueryClient {
  if (!browserQueryClient) browserQueryClient = makeQueryClient();
  return browserQueryClient;
}
