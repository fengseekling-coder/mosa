import { startMosaRuntime } from "./lib/mosa-runtime.mjs";
import { parseDisabledBridges } from "./lib/runtime-bridges.mjs";

const disabledBridges = parseDisabledBridges({ env: process.env });
const runtime = await startMosaRuntime(disabledBridges.length > 0 ? { disabledBridges } : {});
console.log(`MOSA: ${runtime.url}`);

let shutdownPromise = null;

function shutdown(exitCode) {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = runtime.stop().then(
    () => process.exit(exitCode),
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
  return shutdownPromise;
}

process.once("SIGINT", () => { void shutdown(0); });
process.once("SIGTERM", () => { void shutdown(0); });
