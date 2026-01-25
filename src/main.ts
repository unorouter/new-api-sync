import { loadConfig } from "@/lib/config";
import { sync } from "@/sync";

const config = await loadConfig(process.argv[2] ?? "./config.json");

// // Filter to only include specific providers (for testing)
// config.providers = config.providers.filter((p) => p.name === "duck");

const report = await sync(config);

if (!report.success) process.exit(1);
