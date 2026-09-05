/**
 * Force-disable default sinks for every bun test process so inherited
 * OAR_CODEX_* / OAR_ARGO_* overrides cannot write developer files.
 */
process.env.OAR_SINKS = "0";
