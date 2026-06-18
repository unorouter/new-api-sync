import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

interface VoidModel {
  id: string;
  plan_requirements?: string[];
}

// VoidAI (api.voidai.app/v1) - multi-vendor gateway. ~92 models, 77 free-tier. Frontier
// premium claims (gpt-5.x, o3/o4, claude, gemini-pro) are FAKED or plan-gated - a "gpt-5.2"
// request self-reports as GPT-4.1, claude-haiku returns "plan does not have access". The
// open-model tier (deepseek/kimi/glm/qwen/gemini-flash/gpt-oss/sonar + image) serves authentic
// (served id matches request). So: free-tier filter + EXCLUDE the premium-text fakes. The sync
// authenticity probe + served-id match is the second line of defense.
const PREMIUM_FAKE = [
  /^gpt-[45]/,
  /^chatgpt/,
  /^o[34]-/,
  /^claude/,
  /^gemini-[\d.]+-pro/,
];

export async function discoverVoidAiModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/v1/models`;
  consola.info(t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "VoidAI", url }));

  const data = await tryFetchJson<VoidModel[] | { data: VoidModel[] }>(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    timeoutMs: 15_000,
  });

  const list = Array.isArray(data) ? data : (data?.data ?? []);
  const models = list
    .filter((m) => (m.plan_requirements ?? []).includes("free"))
    .map((m) => m.id)
    .filter((id) => !PREMIUM_FAKE.some((re) => re.test(id)));
  return { models, maxOutputByModel: new Map() };
}
