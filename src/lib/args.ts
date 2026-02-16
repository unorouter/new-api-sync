export interface ParsedArgs {
  configPath?: string;
  only: string[];
}

export function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = { only: [] };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    if (arg === "--only") {
      i++;
      const val = argv[i];
      if (val) {
        result.only.push(...val.split(",").map((s) => s.trim()).filter(Boolean));
      }
    } else if (arg.startsWith("--only=")) {
      result.only.push(...arg.slice(7).split(",").map((s) => s.trim()).filter(Boolean));
    } else if (!arg.startsWith("--")) {
      result.configPath = arg;
    }
    i++;
  }
  return result;
}
