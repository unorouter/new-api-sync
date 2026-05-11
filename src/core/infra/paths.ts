import { join } from "path";

export function logsDir(): string {
  return join(process.cwd(), "logs");
}
