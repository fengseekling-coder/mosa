import { startMosaRuntime } from "./lib/mosa-runtime.mjs";

const runtime = await startMosaRuntime();
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
