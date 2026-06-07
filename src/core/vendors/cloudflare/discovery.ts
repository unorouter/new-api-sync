import { tryFetchJson } from "@core/infra/http";
import type { OpenAIFreeDiscovery } from "@core/vendors/shared/openai-free-provider";
import type { ModelType } from "@core/types";
import { t } from "@server/i18n";
import { consola } from "consola";

interface CloudflareModelProperty {
  property_id: string;
  value: unknown;
}
interface CloudflareModel {
  name: string;
  properties?: CloudflareModelProperty[];
}
interface CloudflareModelSearch {
  result?: CloudflareModel[];
  success?: boolean;
}

/**
 * Discover Workers AI text models from the REST catalog. Cloudflare has no
 * OpenAI-style /v1/models list; the catalog lives at ".../ai/models/search"
 * (sibling of the OpenAI-compat chat surface ".../ai/v1/chat/completions") and is
 * filtered by the "Text Generation" task. baseUrl is the ".../ai" root (the
 * runner appends /v1/chat/completions); we append /models/search here. Model ids
 * ("@cf/meta/...") are used verbatim on the chat surface. context_window is the
 * only size the catalog exposes, so it doubles as the output ceiling (a
 * max_tokens above it 400s upstream).
 */
export async function discoverCloudflareModels(
  baseUrl: string,
  apiKey: string,
): Promise<OpenAIFreeDiscovery> {
  const searchBase = baseUrl.replace(/\/$/, "").replace(/\/v1$/, "");
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
  const fetchTask = (task: string) => {
    const url = `${searchBase}/models/search?task=${task}&per_page=100`;
    consola.info(
      t("CORE.PROVIDER.DISCOVERY_FETCH", { label: "Cloudflare", url }),
    );
    return tryFetchJson<CloudflareModelSearch>(url, {
      headers,
      timeoutMs: 15_000,
    });
  };

  const [textGen, embeddings, image, asr, tts] = await Promise.all([
    fetchTask("Text+Generation"),
    fetchTask("Text+Embeddings"),
    fetchTask("Text-to-Image"),
    fetchTask("Automatic+Speech+Recognition"),
    fetchTask("Text-to-Speech"),
  ]);

  const models: string[] = [];
  const maxOutputByModel = new Map<string, number>();
  const modelTypeHints = new Map<string, ModelType>();
  // img2img / inpainting / flux-2 (klein + dev) variants want a multipart image
  // input, not a bare prompt, so the text-to-image probe can't drive them; drop.
  const needsImageInput = (name: string) =>
    /img2img|inpainting|flux-2|edit/i.test(name);

  const add = (rows: CloudflareModel[] | undefined, type: ModelType | null) => {
    for (const m of rows ?? []) {
      if (!m.name) continue;
      if (type === "image" && needsImageInput(m.name)) continue;
      models.push(m.name);
      if (type) modelTypeHints.set(m.name, type);
      const ctx = m.properties?.find((p) => p.property_id === "context_window");
      const ctxValue =
        typeof ctx?.value === "string"
          ? Number.parseInt(ctx.value, 10)
          : typeof ctx?.value === "number"
            ? ctx.value
            : Number.NaN;
      if (Number.isFinite(ctxValue) && ctxValue > 0)
        maxOutputByModel.set(m.name, ctxValue);
    }
  };
  add(textGen?.result, null); // null -> name-based inference (chat vs other)
  add(embeddings?.result, "embedding");
  add(image?.result, "image");
  add(asr?.result, "audio");
  add(tts?.result, "audio");

  return { models, maxOutputByModel, modelTypeHints };
}
