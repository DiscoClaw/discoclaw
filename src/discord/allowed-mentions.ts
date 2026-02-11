// Centralize mention policy: Discoclaw should not ping users/roles/@everyone from model output.
// If you need targeted mentions later, plumb an explicit allowlist into the send call.
export const NO_MENTIONS = { parse: [] as const };

