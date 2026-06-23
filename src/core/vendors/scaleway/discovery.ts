import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface ScalewayModel {
  id: string;
}

// Scaleway Generative APIs (api.scaleway.ai/v1). OpenAI-compatible; auth is the IAM
// secret key as the Bearer token (the access-key id is only for S3 signing, unused
// here). 1M free tokens for new accounts, then pay-per-use. Standard /v1/models shape.
export async function discoverScalewayModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "Scaleway", url }));

  const data = await tryFetchJson<ScalewayModel[] | { data: ScalewayModel[] }>(
    url,
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      timeoutMs: 15_000,
    },
  );

  const list = Array.isArray(data) ? data : (data?.data ?? []);
  return { models: list.map((m) => m.id), maxOutputByModel: new Map() };
}
