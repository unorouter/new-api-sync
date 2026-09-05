import { fetchJsonResult } from "@core/infra/http";
import { t } from "@server/i18n";
import { consola } from "consola";

// Routes only the unorouter fork of new-api has (added with its scoped sync
// token): /api/models/list, /api/models/orphaned and
// /api/token/guest-model-limits. Vanilla new-api lacks all three together.
export interface GatewayCaps {
  syncRoutes: boolean;
}

export interface ClientContext {
  baseUrl: string;
  headers: Record<string, string>;
  name: string;
  caps: () => Promise<GatewayCaps>;
}

// One request decides which gateway this is. Only the guest-limits route gives
// a real 404 on vanilla (the models routes fall into `/api/models/:id` there),
// and an empty body fails the fork's validation before any write. Anything but
// a 404 counts as the fork, so a transient failure never flips a fork target
// onto the vanilla paths.
export function makeClientContext(
  baseUrl: string,
  headers: Record<string, string>,
  name: string,
): ClientContext {
  let caps: Promise<GatewayCaps> | undefined;
  const probe = async (): Promise<GatewayCaps> => {
    const r = await fetchJsonResult<{ success?: boolean }>(
      `${baseUrl}/api/token/guest-model-limits`,
      { method: "PUT", headers, body: {} },
    );
    const syncRoutes = !(r.ok === false && r.status === 404);
    if (!syncRoutes) consola.info(t("CORE.NEWAPI.VANILLA_GATEWAY", { name }));
    return { syncRoutes };
  };
  return { baseUrl, headers, name, caps: () => (caps ??= probe()) };
}
