import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { preflightC2paProductionSigner } from "../lib/c2pa-production-signer.mjs";

export async function checkC2paProductionSigner({ signerPath } = {}) {
  return preflightC2paProductionSigner({ signerPath });
}

function parseArgs(argv) {
  let signerPath = "";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--signer") {
      signerPath = argv[++index] || "";
      if (!signerPath) throw new Error("Missing value for --signer.");
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!signerPath) throw new Error("--signer is required.");
  return { signerPath };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await checkC2paProductionSigner(args);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && invokedPath === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`${error?.code ? `${error.code}: ` : ""}${error?.message || error}\n`);
    process.exitCode = 1;
  });
}
