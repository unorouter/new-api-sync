import { loadRuntimeConfig } from "@/cli/helpers";
import { printResetSummary } from "@/core/output";
import { runReset } from "@/core/reset";

export interface ResetCommandOptions {
  config?: string;
  only: string[];
  json?: boolean;
}

export async function resetCommand(
  options: ResetCommandOptions
): Promise<void> {
  const config = await loadRuntimeConfig(options.config, options.only);
  const result = await runReset(config);

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  printResetSummary(result);
}
