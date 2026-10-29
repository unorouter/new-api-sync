import {
  DATA_POLICY_PROMPTS,
  DATA_POLICY_TRANSFER,
  type AnyProviderConfig,
  type DataPolicyPrompts,
  type DataPolicyTransfer,
} from "@core/validations/config";

interface DataPolicyFields {
  providerName?: string;
  seatCountry?: string;
  prompts?: DataPolicyPrompts;
  transfer?: DataPolicyTransfer;
}

// The gateway's channel setting.data_policy shape.
export interface DataPolicy {
  provider?: string;
  seat_country?: string;
  prompts?: DataPolicyPrompts;
  transfer?: DataPolicyTransfer;
}

// Researched per upstream host on 2026-10-14 and 2026-10-19 (seat, DPF list,
// DPA terms, training clauses); evidence in the daten repo,
// 2026/data-protection/2026-10-14_anbieter-datenschutz.json. Kept in the repo so
// the cluster config (a7, ih, si only) carries it too. A field set on the
// provider block in config.yml wins. Providers absent here publish no data_policy.
// prettier-ignore
const BY_NAME: Record<string, DataPolicyFields> = {
  a7: { seatCountry: "CN", prompts: "retains", transfer: "none" },
  // WeChat 21.10.2026 (SuperLong1129): stores and trains on nothing itself, seat US, but forwards to OpenAI, whose API keeps inputs up to 30 days for abuse monitoring.
  aaw1: { seatCountry: "US", prompts: "retains", transfer: "none" },
  acx1: { prompts: "unknown", transfer: "none" },
  agnes1: { seatCountry: "SG", prompts: "trains", transfer: "none" },
  ah1: { prompts: "unknown", transfer: "none" },
  ahm1: { prompts: "none", transfer: "none" },
  akiyo: { seatCountry: "CN", prompts: "unknown", transfer: "none" },
  amd1: { seatCountry: "CN", prompts: "unknown", transfer: "none" },
  an1: { seatCountry: "US", prompts: "unknown", transfer: "none" },
  apx1: { prompts: "unknown", transfer: "none" },
  arli1: { prompts: "none", transfer: "unknown" },
  art1: { seatCountry: "CN", prompts: "unknown", transfer: "none" },
  axon1: { prompts: "unknown", transfer: "none" },
  axz1: { seatCountry: "CN", prompts: "unknown", transfer: "none" },
  bb1: { seatCountry: "DE", prompts: "unknown", transfer: "adequacy" },
  bcf1: { seatCountry: "CN", prompts: "unknown", transfer: "none" },
  br1: { seatCountry: "US", prompts: "unknown", transfer: "none" },
  cc1: { prompts: "none", transfer: "none" },
  ce1: { seatCountry: "CA", prompts: "trains", transfer: "adequacy" },
  cent: { seatCountry: "GB", prompts: "unknown", transfer: "adequacy" },
  cf1: { seatCountry: "US", prompts: "none", transfer: "dpf" },
  cf2: { seatCountry: "US", prompts: "none", transfer: "dpf" },
  cfr1: { seatCountry: "PL", prompts: "none", transfer: "adequacy" },
  cha1: { seatCountry: "CN", prompts: "unknown", transfer: "none" },
  cln1: { prompts: "none", transfer: "none" },
  cxr1: { prompts: "unknown", transfer: "none" },
  dsg1: { prompts: "trains", transfer: "none" },
  duck: { seatCountry: "SG", prompts: "none", transfer: "scc" },
  el1: { seatCountry: "RU", prompts: "unknown", transfer: "none" },
  fa1: { seatCountry: "US", prompts: "unknown", transfer: "none" },
  fish: { seatCountry: "CN", prompts: "retains", transfer: "none" },
  fm1: { prompts: "unknown", transfer: "none" },
  fta1: { prompts: "none", transfer: "none" },
  fvg1: { seatCountry: "CN", prompts: "unknown", transfer: "none" },
  gg: { seatCountry: "CN", prompts: "unknown", transfer: "none" },
  gnk1: { seatCountry: "US", prompts: "unknown", transfer: "none" },
  gq1: { seatCountry: "US", prompts: "unknown", transfer: "scc" },
  hd1: { seatCountry: "LU", prompts: "retains", transfer: "adequacy" },
  hg1: { seatCountry: "US", prompts: "none", transfer: "none" },
  htz1: { seatCountry: "DE", prompts: "none", transfer: "adequacy" },
  ih: { seatCountry: "ID", prompts: "retains", transfer: "none" },
  incp1: { seatCountry: "US", prompts: "trains", transfer: "none" },
  io1: { seatCountry: "US", prompts: "unknown", transfer: "none" },
  it1: { seatCountry: "CN", prompts: "unknown", transfer: "none" },
  jev1: { seatCountry: "US", prompts: "retains", transfer: "scc" },
  jn1: { seatCountry: "DE", prompts: "none", transfer: "adequacy" },
  k2h1: { seatCountry: "AE", prompts: "unknown", transfer: "none" },
  k2h2: { seatCountry: "AE", prompts: "unknown", transfer: "none" },
  kdy1: { seatCountry: "CN", prompts: "unknown", transfer: "none" },
  kn1: { seatCountry: "ID", prompts: "none", transfer: "none" },
  lf1: { seatCountry: "US", prompts: "retains", transfer: "none" },
  // Written statement 21.10.2026 (linkapi@163.com): no storage of request content, no training, partners likewise; servers US.
  lkp1: { seatCountry: "HK", prompts: "none", transfer: "none" },
  llm71: { seatCountry: "GB", prompts: "unknown", transfer: "unknown" },
  lmh1: { prompts: "unknown", transfer: "none" },
  lnk1: { seatCountry: "HK", prompts: "none", transfer: "none" },
  lt1: { seatCountry: "TR", prompts: "none", transfer: "none" },
  // Discord 29.10.2026 (Eliza, operator): stores nothing itself and drops providers known to store, but routes to LinkAPI, rout.my, Venice, OpenRouter, DeepSeek, Mistral, AtlasCloud, Novita, DeepInfra and Google AI Studio, whose free tier trains on inputs.
  ltr1: { seatCountry: "US", prompts: "trains", transfer: "none" },
  lum1: { prompts: "unknown", transfer: "none" },
  mdl1: { seatCountry: "US", prompts: "none", transfer: "scc" },
  mega1: { seatCountry: "CA", prompts: "retains", transfer: "unknown" },
  mist1: { seatCountry: "FR", prompts: "trains", transfer: "adequacy" },
  mnn1: { seatCountry: "RU", prompts: "unknown", transfer: "none" },
  mp1: { seatCountry: "US", prompts: "none", transfer: "unknown" },
  ms1: { prompts: "unknown", transfer: "unknown" },
  mx1: { seatCountry: "US", prompts: "none", transfer: "none" },
  nara1: { seatCountry: "ID", prompts: "none", transfer: "none" },
  nbi1: { seatCountry: "CN", prompts: "retains", transfer: "none" },
  ng1: { prompts: "trains", transfer: "none" },
  nio1: { seatCountry: "CN", prompts: "unknown", transfer: "none" },
  no1: { seatCountry: "CN", prompts: "unknown", transfer: "none" },
  oc1: { seatCountry: "SG", prompts: "none", transfer: "scc" },
  oc2: { seatCountry: "SG", prompts: "none", transfer: "scc" },
  ocz1: { seatCountry: "US", prompts: "trains", transfer: "none" },
  om1: { seatCountry: "US", prompts: "none", transfer: "none" },
  ox1: { prompts: "none", transfer: "none" },
  pls1: { seatCountry: "US", prompts: "unknown", transfer: "scc" },
  pm1: { seatCountry: "DE", prompts: "none", transfer: "adequacy" },
  pol: { seatCountry: "HK", prompts: "retains", transfer: "none" },
  pu1: { seatCountry: "US", prompts: "unknown", transfer: "none" },
  qnn1: { seatCountry: "CN", prompts: "unknown", transfer: "none" },
  qwen1: { seatCountry: "CN", prompts: "trains", transfer: "none" },
  rout1: { prompts: "none", transfer: "none" },
  rqst1: { seatCountry: "GB", prompts: "unknown", transfer: "unknown" },
  rtw1: { prompts: "unknown", transfer: "none" },
  rv1: { seatCountry: "US", prompts: "unknown", transfer: "unknown" },
  rw1: { seatCountry: "GB", prompts: "retains", transfer: "adequacy" },
  sense1: { seatCountry: "CN", prompts: "unknown", transfer: "none" },
  shu1: { seatCountry: "CN", prompts: "unknown", transfer: "none" },
  si: { seatCountry: "US", prompts: "retains", transfer: "none" },
  sim1: { seatCountry: "US", prompts: "retains", transfer: "dpf" },
  sk1: { prompts: "unknown", transfer: "none" },
  sl1: { seatCountry: "SG", prompts: "trains", transfer: "none" },
  sv1: { seatCountry: "IN", prompts: "trains", transfer: "none" },
  syk1: { prompts: "unknown", transfer: "none" },
  thb1: { seatCountry: "NL", prompts: "unknown", transfer: "scc" },
  thr1: { seatCountry: "SG", prompts: "none", transfer: "none" },
  tkr1: { seatCountry: "US", prompts: "none", transfer: "none" },
  tph1: { seatCountry: "TH", prompts: "unknown", transfer: "none" },
  trp1: { seatCountry: "GB", prompts: "unknown", transfer: "unknown" },
  ts1: { seatCountry: "CN", prompts: "unknown", transfer: "none" },
  tt1: { prompts: "none", transfer: "none" },
  unt1: { seatCountry: "US", prompts: "none", transfer: "none" },
  wb1: { seatCountry: "US", prompts: "unknown", transfer: "scc" },
  wuh1: { seatCountry: "CN", prompts: "unknown", transfer: "none" },
  xk1: { prompts: "none", transfer: "none" },
  ying1: { seatCountry: "CN", prompts: "unknown", transfer: "none" },
  yjs1: { seatCountry: "HK", prompts: "unknown", transfer: "none" },
  zai1: { seatCountry: "SG", prompts: "unknown", transfer: "none" },
  zm1: { seatCountry: "SG", prompts: "unknown", transfer: "none" },
};

// Numbered shard families, so a new shard inherits its family's policy.
// prettier-ignore
const BY_FAMILY: Array<[RegExp, DataPolicyFields]> = [
  [/^any\d+$/, { seatCountry: "US", prompts: "unknown", transfer: "none" }],
  [/^atr\d+$/, { seatCountry: "CN", prompts: "unknown", transfer: "none" }],
  [/^cat\d+$/, { seatCountry: "US", prompts: "unknown", transfer: "none" }],
  [/^cfp\d+$/, { seatCountry: "US", prompts: "unknown", transfer: "none" }],
  [/^chat\d+$/, { seatCountry: "CN", prompts: "trains", transfer: "none" }],
  [/^dahl\d+$/, { seatCountry: "EE", prompts: "unknown", transfer: "none" }],
  [/^ey\d+$/, { prompts: "unknown", transfer: "none" }],
  [/^gem\d+$/, { seatCountry: "US", prompts: "trains", transfer: "dpf" }],
  [/^gm\d+$/, { seatCountry: "US", prompts: "trains", transfer: "dpf" }],
  [/^kl\d+$/, { seatCountry: "US", prompts: "unknown", transfer: "unknown" }],
  [/^mars\d+$/, { prompts: "retains", transfer: "none" }],
  [/^nvda\d+$/, { seatCountry: "US", prompts: "trains", transfer: "dpf" }],
  [/^open\d+$/, { seatCountry: "US", prompts: "unknown", transfer: "unknown" }],
  [/^qr\d+$/, { prompts: "none", transfer: "none" }],
  [/^rdx\d+$/, { prompts: "none", transfer: "none" }],
  [/^utim\d+$/, { prompts: "unknown", transfer: "none" }],
  [/^vy\d+$/, { seatCountry: "US", prompts: "trains", transfer: "dpf" }],
  [/^ws\d+$/, { seatCountry: "US", prompts: "unknown", transfer: "unknown" }],
];

// Who operates the upstream, as named in the free model consent dialog. Only
// providers that serve :free models; where the legal entity is not verified
// the brand and domain stand in.
// prettier-ignore
const PROVIDER_NAME: Record<string, string> = {
  akiyo: "newapi.akiyo.fun",
  axz1: "ai.axzt.top",
  bb1: "Forschungszentrum Jülich GmbH (Blablador)",
  br1: "BlockRun (blockrun.ai)",
  ce1: "Cohere Inc.",
  cf1: "Cloudflare, Inc. (Workers AI)",
  cf2: "Cloudflare, Inc. (Workers AI)",
  cfr1: "CloudFerro S.A.",
  dsg1: "myapi.creitingameplays.com",
  gq1: "Groq, Inc.",
  hd1: "AI Horde (aihorde.net)",
  htz1: "Hetzner Online GmbH",
  jn1: "Jina AI GmbH",
  k2h1: "MBZUAI (K2 Think)",
  k2h2: "MBZUAI (K2 Think)",
  ltr1: "LiteRouter (literouter.com)",
  mx1: "Mixlayer (mixlayer.ai)",
  nara1: "Nara (bynara.id)",
  ng1: "NagaAI (naga.ac)",
  qr5: "Qronos (qronos.me)",
  rqst1: "Requesty (requesty.ai)",
  sense1: "SenseTime (SenseNova)",
  shu1: "shu26.cfd",
  sl1: "AI Singapore (SEA-LION)",
  tph1: "Typhoon (opentyphoon.ai)",
  trp1: "TokenReply (tokenreply.com)",
  wuh1: "wuhu.lol",
  yjs1: "yjs.im",
  zai1: "Z.ai (api.z.ai)",
  zm1: "ZenMux (zenmux.ai)",
};

// prettier-ignore
const PROVIDER_NAME_BY_FAMILY: Array<[RegExp, string]> = [
  [/^cat\d+$/, "ch.at"],
  [/^cfp\d+$/, "Cloudflare, Inc. (AI Playground)"],
  [/^chat\d+$/, "Zhipu AI (chatglm.cn)"],
  [/^dahl\d+$/, "Dahl (inference.dahl.global)"],
  [/^ey\d+$/, "eye2.ai"],
  [/^gem\d+$/, "Google LLC (Gemini API)"],
  [/^gm\d+$/, "Google LLC (Gemini)"],
  [/^kl\d+$/, "Kilo Code (kilo.ai)"],
  [/^mars\d+$/, "marsai.click"],
  [/^nvda\d+$/, "NVIDIA Corporation"],
  [/^open\d+$/, "OpenRouter, Inc."],
];

function defaultsFor(name: string): DataPolicyFields | undefined {
  const fields =
    BY_NAME[name] ?? BY_FAMILY.find((entry) => entry[0].test(name))?.[1];
  const providerName =
    PROVIDER_NAME[name] ??
    PROVIDER_NAME_BY_FAMILY.find((entry) => entry[0].test(name))?.[1];
  if (!fields && !providerName) return undefined;
  return { ...fields, ...(providerName ? { providerName } : {}) };
}

export function withDataPolicyDefaults(
  provider: AnyProviderConfig,
): AnyProviderConfig {
  const defaults = defaultsFor(provider.name);
  if (!defaults) return provider;
  return {
    ...provider,
    providerName: provider.providerName ?? defaults.providerName,
    seatCountry: provider.seatCountry ?? defaults.seatCountry,
    prompts: provider.prompts ?? defaults.prompts,
    transfer: provider.transfer ?? defaults.transfer,
  };
}

export function dataPolicyOf(
  provider: DataPolicyFields,
): DataPolicy | undefined {
  const policy: DataPolicy = {
    ...(provider.providerName ? { provider: provider.providerName } : {}),
    ...(provider.seatCountry ? { seat_country: provider.seatCountry } : {}),
    ...(provider.prompts ? { prompts: provider.prompts } : {}),
    ...(provider.transfer ? { transfer: provider.transfer } : {}),
  };
  return Object.keys(policy).length > 0 ? policy : undefined;
}

// The gateway keys a consent on the set of providers behind a model, so every
// declared provider carries an identity: the operator name when known, else
// the lane family, so chat1..chat53 count as one provider and a new shard does
// not void consents. Internal only, the gateway never publishes it.
function providerIdentity(provider: AnyProviderConfig): string {
  return (
    provider.providerName ??
    (provider.name.replace(/\d+$/, "") || provider.name)
  );
}

// Channel tag -> policy, for the providers this config declares. A tag the
// config does not declare is absent, so callers leave those channels alone.
export function dataPolicyByTag(
  providers: AnyProviderConfig[],
): Map<string, DataPolicy> {
  const byTag = new Map<string, DataPolicy>();
  for (const provider of providers) {
    const policy: DataPolicy = {
      provider: providerIdentity(provider),
      ...dataPolicyOf(provider),
    };
    byTag.set(provider.name, policy);
    if ("channelTag" in provider && provider.channelTag)
      byTag.set(provider.channelTag, policy);
  }
  return byTag;
}

// Fixed key order, so a policy the gateway re-serialised compares equal.
export function readDataPolicy(value: unknown): DataPolicy | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const raw = new Map(Object.entries(value));
  const pick = (key: string) => {
    const v = raw.get(key);
    return typeof v === "string" && v !== "" ? v : undefined;
  };
  const name = pick("provider");
  const seat = pick("seat_country");
  const prompts = pick("prompts");
  const transfer = pick("transfer");
  const policy = {
    ...(name ? { provider: name } : {}),
    ...(seat ? { seat_country: seat } : {}),
    ...(prompts && isPrompts(prompts) ? { prompts } : {}),
    ...(transfer && isTransfer(transfer) ? { transfer } : {}),
  };
  return Object.keys(policy).length > 0 ? policy : undefined;
}

const PROMPTS = new Set<string>(DATA_POLICY_PROMPTS);
const TRANSFER = new Set<string>(DATA_POLICY_TRANSFER);

function isPrompts(v: string): v is DataPolicyPrompts {
  return PROMPTS.has(v);
}

function isTransfer(v: string): v is DataPolicyTransfer {
  return TRANSFER.has(v);
}

export function sameDataPolicy(a?: DataPolicy, b?: DataPolicy): boolean {
  return (
    a?.provider === b?.provider &&
    a?.seat_country === b?.seat_country &&
    a?.prompts === b?.prompts &&
    a?.transfer === b?.transfer
  );
}

// Adds data_policy to a channel setting JSON, keeping every other key.
export function settingWithDataPolicy(
  setting: string | undefined,
  policy: DataPolicy,
): string | undefined {
  let parsed: Record<string, unknown> = {};
  if (setting) {
    try {
      const value: unknown = JSON.parse(setting);
      if (!value || typeof value !== "object" || Array.isArray(value))
        return setting;
      parsed = Object.fromEntries(Object.entries(value));
    } catch {
      return setting;
    }
  }
  parsed.data_policy = policy;
  return JSON.stringify(parsed);
}
