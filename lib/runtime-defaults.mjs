/**
 * Keep the legacy bridge and desktop-owned runtime on different ports. They
 * serve different lifecycle and storage contracts, so these are deliberately
 * separate defaults rather than aliases for one shared listener.
 */
export const DEFAULT_MOSA_PORT = 43517;
export const DEFAULT_MOSA_DESKTOP_PORT = 43519;

export function normalizeMosaPort(value, { allowZero = false, label = "MOSA port" } = {}) {
  const port = Number(value);
  const minimum = allowZero ? 0 : 1;
  if (!Number.isInteger(port) || port < minimum || port > 65_535) {
    throw new Error(`${label} must be an integer from ${minimum} to 65535.`);
  }
  return port;
}
