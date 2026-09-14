// The gateway writes `other_info.status_reason` as "status_code=<n>, <message>"
// when it auto disables a channel (relaykit/types/error.go ErrorWithStatusCode).
// Only a credential fault means the lane's key is wrong; every other reason is
// the merchant or the upstream and says nothing about the key we hold.
const CREDENTIAL_PHRASES = [
  "账号或令牌状态不允许",
  "invalid token",
  "api key not valid",
  "api_key_invalid",
  "incorrect api key",
  "invalid api key",
  "令牌无效",
];

export interface DisableReason {
  statusCode?: number;
  credential: boolean;
  reason: string;
}

export function parseDisableReason(otherInfo?: string): DisableReason {
  let reason = "";
  if (otherInfo) {
    try {
      const parsed: unknown = JSON.parse(otherInfo);
      if (parsed && typeof parsed === "object") {
        const r = (parsed as Record<string, unknown>).status_reason;
        if (typeof r === "string") reason = r;
      }
    } catch {
      reason = "";
    }
  }
  const code = /status_code=(\d+)/.exec(reason)?.[1];
  const statusCode = code ? Number(code) : undefined;
  const lower = reason.toLowerCase();
  const credential =
    statusCode === 401 ||
    statusCode === 403 ||
    CREDENTIAL_PHRASES.some((p) => lower.includes(p));
  return { statusCode, credential, reason };
}
