import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import { t } from "@server/i18n";
import { consola } from "consola";

// OpenAI first-party (api.openai.com/v1), complimentary-tokens program: with data-sharing
// opt-in, traffic on a fixed model set is FREE up to a daily cap (250k/day big + 2.5M/day mini
// on tier 1-2; 1M/10M on tier 3+), resetting 00:00 UTC. Over-cap OR any OTHER model bills the
// card at standard rates - so ONLY the complimentary-eligible ids are exposed (hardcoded, never
// discovered) to guarantee no request ever silently bills. List mirrors the console's eligibility
// text; keep in sync if OpenAI revises it. gpt-image/dall-e/embeddings/audio are NOT eligible.
const FREE_ELIGIBLE = [
  // big pool - 250k/day (t1-2) or 1M/day (t3+)
  "gpt-5.4",
  "gpt-5.2",
  "gpt-5.1",
  "gpt-5",
  "gpt-5-chat-latest",
  "gpt-4.1",
  "gpt-4o",
  "o1",
  "o3",
  // mini pool - 2.5M/day (t1-2) or 10M/day (t3+)
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5-mini",
  "gpt-5-nano",
  "gpt-4.1-mini",
  "gpt-4.1-nano",
  "gpt-4o-mini",
  "o1-mini",
  "o3-mini",
  "o4-mini",
];

export async function discoverOpenAiModels(
  _baseUrl: string,
  _apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  consola.info(
    t("CORE.PROVIDER.DISCOVERY_FETCH", {
      label: "OpenAI",
      url: "(complimentary-tokens eligible set)",
    }),
  );
  return { models: FREE_ELIGIBLE, maxOutputByModel: new Map() };
}
