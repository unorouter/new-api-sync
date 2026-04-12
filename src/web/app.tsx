import { QueryClientProvider } from "@tanstack/react-query";
import { AppShell } from "@web/components/layout/app-shell";
import { Toaster } from "@web/components/ui/sonner";
import getQueryClient from "@web/lib/react-query/client";

const queryClient = getQueryClient();

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AppShell />
      <Toaster />
    </QueryClientProvider>
  );
}
