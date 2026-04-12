import { treaty } from "@elysiajs/eden";
import type { App } from "@server/route";

export const rpc = treaty<App>(
  typeof window === "undefined"
    ? `http://localhost:${process.env.PORT ?? "3000"}`
    : window.location.origin,
);
