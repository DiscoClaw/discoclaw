/**
 * Consistent error message for unauthorized config mutation attempts.
 * Distinct from validation errors so callers can distinguish auth failures.
 */
export const CONFIG_UNAUTHORIZED_ERROR =
  'Unauthorized: only allowlisted users can change bot configuration. This request was denied.';
