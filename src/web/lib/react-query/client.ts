import { QueryClient } from "@tanstack/react-query";

export function makeQueryClient(): QueryClient {
  return new QueryClient();
}

let browserQueryClient: QueryClient | undefined;

export default function getQueryClient(): QueryClient {
  if (!browserQueryClient) browserQueryClient = makeQueryClient();
  return browserQueryClient;
}
