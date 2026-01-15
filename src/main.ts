/**
 * proxy-sync entry point
 *
 * Usage:
 *   bun run src/main.ts
 *   bun run src/main.ts ./path/to/config.json
 */

import { sync, loadConfig } from "@/index";

const configPath = process.argv[2] ?? "./config.json";

console.log(`Loading config from: ${configPath}\n`);

const config = await loadConfig(configPath);
const report = await sync(config);

// Exit with error code if sync failed
if (!report.success) {
  process.exit(1);
}
