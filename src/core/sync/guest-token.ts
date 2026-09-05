import { modelsOnChannels } from "@core/catalog/constants/patterns";
import type { Channel } from "@core/types";
import type { NewApiClient } from "@core/vendors/newapi/client";
import { t } from "@server/i18n";
import { consola } from "consola";

interface GuestTokenUpdateResult {
  configured: boolean;
  updated: boolean;
  freeModelCount: number;
}

// GUEST_API_KEY: refresh the guest token's model_limits from the FULL served
// `:free` catalog, regardless of channel status. model_limits is a wholesale
// overwrite, so computing it from one run's scope evicted every free model
// outside it (a `--only qwen1` run dropped 175 live free models). A free model
// whose channel is currently disabled stays allowed so it works the instant the
// channel recovers; listing it costs nothing (it fails at routing, not auth).
export async function updateGuestTokenIfConfigured(
  target: NewApiClient,
  channels: Channel[],
): Promise<GuestTokenUpdateResult> {
  const guestKey = Bun.env.GUEST_API_KEY;
  if (!guestKey)
    return { configured: false, updated: false, freeModelCount: 0 };

  const freeNames = [
    ...modelsOnChannels(channels, {
      enabledOnly: false,
      includeAliases: false,
    }),
  ]
    .filter((name) => name.endsWith(":free"))
    .sort();
  const ok = await target.updateGuestTokenModelLimits(
    guestKey,
    freeNames.join(","),
  );
  if (!ok) return { configured: true, updated: false, freeModelCount: 0 };

  consola.info(
    t("CORE.NEWAPI.GUEST_TOKEN_UPDATED", {
      name: "guest",
      count: freeNames.length,
    }),
  );
  return { configured: true, updated: true, freeModelCount: freeNames.length };
}
