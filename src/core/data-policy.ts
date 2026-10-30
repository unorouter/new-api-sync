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

// Exact lane name first, then its family (name without digits), field by field,
// so a new shard inherits its family's policy.
function defaultsFor(
  name: string,
  policies: Record<string, DataPolicyFields>,
): DataPolicyFields {
  const family = name.replace(/\d+$/, "");
  return {
    ...(family !== name ? policies[family] : undefined),
    ...policies[name],
  };
}

export function withDataPolicyDefaults(
  provider: AnyProviderConfig,
  policies: Record<string, DataPolicyFields>,
): AnyProviderConfig {
  const defaults = defaultsFor(provider.name, policies);
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
// the lane family, so a numbered series counts as one provider and a new shard does
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
