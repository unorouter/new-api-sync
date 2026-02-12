import { loadConfig } from "@/lib/config";
import { ResetService } from "@/service/reset";

const config = await loadConfig(process.argv[2]);
await new ResetService(config).reset();
