export { MODEL_TYPES, type ModelType } from "./types";

export const MANAGED_OPTION_KEYS = [
  "GroupRatio",
  "UserUsableGroups",
  "AutoGroups",
  "DefaultUseAutoGroup",
  "ModelRatio",
  "CompletionRatio",
  "ModelPrice",
  "ImageRatio",
  "ModelQuotaType",
  "ModelGridPricing",
] as const;

export const PAGINATION = {
  DEFAULT_PAGE_SIZE: 100,
  START_PAGE_ZERO: 0,
  START_PAGE_ONE: 1,
} as const;

export const TIMEOUTS = {
  MODEL_TEST_MS: 20000,
} as const;

export {
  CHANNEL_TYPES,
  VENDOR_CHANNEL_TYPES,
  getTaskModelOverride,
  getTaskChannelType,
  inferChannelType,
  inferChannelTypeFromModels,
} from "./constants/channel-types";

export {
  ENDPOINT_DEFAULT_PATHS,
  MODEL_TYPE_CANONICAL_ENDPOINT,
  TEXT_ENDPOINT_TYPES,
  ENDPOINT_TO_MODEL_TYPE,
  ENDPOINT_KEYWORD_TYPES,
  NON_TESTABLE_ENDPOINT_TYPES,
  normalizeEndpointType,
  normalizeEndpointTypes,
} from "./constants/endpoints";

export {
  NON_TEXT_MODEL_PATTERNS,
  inferModelType,
  isTestableModel,
} from "./constants/inference";

export {
  type VendorMatcher,
  VENDOR_MATCHERS,
  inferVendorFromModelName,
} from "./constants/vendor-matchers";

export {
  matchPattern,
  matchesBlacklist,
  matchesAnyPattern,
  parseModelList,
  buildReverseMapping,
  sanitizeGroupName,
  SUB2API_PLATFORM_CHANNEL_TYPES,
  VENDOR_TO_SUB2API_PLATFORMS,
  SUB2API_PLATFORM_TO_VENDOR,
} from "./constants/patterns";
