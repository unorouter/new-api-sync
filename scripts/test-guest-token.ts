#!/usr/bin/env bun
import { loadConfig } from "@core/config";
import { updateGuestTokenIfConfigured } from "@core/sync/guest-token";
import { NewApiClient } from "@core/vendors/newapi/client";

const config = await loadConfig();
const target = new NewApiClient(config.target, "target");

const health = await target.healthCheck();
if (!health.ok) {
  console.error("target unreachable:", health.error);
  process.exit(1);
}
console.log("target ok:", health.balance ?? "(no balance)");

const pricing = await target.fetchPricing();
console.log(
  `pricing: ${pricing.models.length} models across ${pricing.groups.length} groups`,
);

const result = await updateGuestTokenIfConfigured(target, pricing);
console.log("result:", result);
