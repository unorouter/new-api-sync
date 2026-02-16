import { loadConfig } from "@/lib/config";
import { parseArgs } from "@/lib/args";
import { SyncService } from "@/service/sync";
import { consola } from "consola";

const args = parseArgs(process.argv.slice(2));
const config = await loadConfig(args.configPath);

if (args.only.length > 0) {
  const allNames = new Set(config.providers.map((p) => p.name));
  const unknown = args.only.filter((name) => !allNames.has(name));
  if (unknown.length > 0) {
    consola.error(`Unknown provider(s): ${unknown.join(", ")}`);
    consola.info(`Available: ${[...allNames].join(", ")}`);
    process.exit(1);
  }
  const onlySet = new Set(args.only);
  config.providers = config.providers.filter((p) => onlySet.has(p.name));
  config.onlyProviders = onlySet;
  consola.info(`Partial sync: ${args.only.join(", ")}`);
}

const report = await new SyncService(config).sync();

if (!report.success) process.exit(1);
