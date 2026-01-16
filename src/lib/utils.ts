export function logInfo(message: string) {
  console.log(`${new Date().toISOString()} [INFO] ${message}`);
}

export function logError(message: string) {
  console.log(`${new Date().toISOString()} [ERROR] ${message}`);
}
