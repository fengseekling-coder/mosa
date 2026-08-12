// BUG-08 fix: preload hook loaded by `npm test` before any test file runs.
//
// It deletes MOSA runtime environment variables inherited from the host shell
// so a leftover value from a previous run (e.g. MOSA_LIBRARY_DIR pointing at
// an old temporary library) can never cause mass false failures. Test files
// may still set their own MOSA_* values afterwards; the caller's parent shell
// is never modified because this only mutates the current process env.

const POLLUTING_MOSA_VARIABLES = [
  "MOSA_LIBRARY_DIR",
  "MOSA_DISABLE_BRIDGES",
  "MOSA_PORT",
  "MOSA_DESKTOP_PORT",
  "MOSA_COWART_REGISTRY",
  "MOSA_COWART_ENDPOINT",
  "MOSA_COWART_REGISTRY_PATH",
  "MOSA_PROJECT_DIR",
  "MOSA_RUNTIME_MODE",
  "MOSA_USER_DATA",
  "MOSA_QA_RUN",
];

for (const name of POLLUTING_MOSA_VARIABLES) {
  delete process.env[name];
}
