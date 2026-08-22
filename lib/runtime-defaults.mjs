/**
 * The browser bridge and desktop shell share one verified local runtime by
 * default. The desktop service manager attaches to that runtime when it owns
 * the same library, instead of starting a second listener.
 */
export const DEFAULT_MOSA_PORT = 43517;
export const DEFAULT_MOSA_DESKTOP_PORT = DEFAULT_MOSA_PORT;

export function normalizeMosaPort(value, { allowZero = false, label = "MOSA port" } = {}) {
  const port = Number(value);
  const minimum = allowZero ? 0 : 1;
  if (!Number.isInteger(port) || port < minimum || port > 65_535) {
    throw new Error(`${label} must be an integer from ${minimum} to 65535.`);
  }
  return port;
}
