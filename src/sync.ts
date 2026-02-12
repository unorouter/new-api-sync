import { loadConfig } from "@/lib/config";
import { SyncService } from "@/service/sync";

const config = await loadConfig(process.argv[2]);

// Filter to only include specific providers (for testing)
// config.providers = config.providers.filter((p) => p.name === "duck");

const report = await new SyncService(config).sync();

if (!report.success) process.exit(1);
