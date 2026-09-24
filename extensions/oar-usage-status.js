/**
 * OMO/Senpi footer: live Grok + Codex remaining % from `oar panel --json`.
 *
 * Install (also done by scripts/install.sh):
 *   ln -sf .../extensions/oar-usage-status.js ~/.omo/agent/extensions/oar-usage-status.js
 *
 * Toggle: /oar-usage
 */
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const STATUS_KEY = "oar-usage";
const INTERVAL_MS = 60_000;
const FETCH_TIMEOUT_MS = 15_000;

function oarBin() {
  return process.env.OAR_BIN || join(homedir(), ".local/bin/oar");
}

function isCodexProvider(provider) {
  const key = String(provider || "").trim().toLowerCase();
  return key === "chatgpt-subscription" || key === "openai-codex" || key === "openai" || key === "codex" || key === "chatgpt";
}

function remoteCols(row) {
  const remote = row?.remote;
  if (!remote?.ok) {
    if (remote && !remote.ok && remote.error) {
      return { session: "err", weekly: "err", grok: "err" };
    }
    return { session: "-", weekly: "-", grok: "-" };
  }
  const session = remote.windows?.find((w) => w.kind === "session");
  const weekly = remote.windows?.find((w) => w.kind === "weekly");
  const grok = remote.windows?.find(
    (w) => w.label === "grok" || (row.provider === "xai" && (w.kind === "weekly" || w.kind === "period")),
  );
  const fmt = (w) => {
    if (!w) return "-";
    if (w.remainingPercent != null) return `${w.remainingPercent}%`;
    if (w.usedPercent != null) return `${Math.max(0, 100 - w.usedPercent)}%`;
    return "-";
  };
  return {
    session: isCodexProvider(row.provider) ? fmt(session) : "-",
    weekly: isCodexProvider(row.provider) ? fmt(weekly) : "-",
    grok: row.provider === "xai" ? fmt(grok) : "-",
  };
}

export function formatOarUsageStatus(snap) {
  if (!snap || !Array.isArray(snap.rows)) return "OAR usage --";
  let grok;
  let codex;
  for (const row of snap.rows) {
    if (!row?.active) continue;
    const cols = remoteCols(row);
    if (row.provider === "xai") grok = `Grok ${cols.grok}`;
    if (isCodexProvider(row.provider)) {
      const bits = [];
      if (cols.session !== "-") bits.push(`5h ${cols.session}`);
      if (cols.weekly !== "-") bits.push(`W ${cols.weekly}`);
      codex = bits.length ? `Codex ${bits.join(" ")}` : "Codex -";
    }
  }
  const parts = [grok, codex].filter(Boolean);
  return parts.length ? parts.join(" | ") : "OAR usage --";
}

export default function (pi) {
  let enabled = true;
  let timer;
  let inFlight = false;
  let lastCtx;

  const stopTimer = () => {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  const refresh = async (ctx) => {
    if (!enabled || !ctx?.hasUI || inFlight) return;
    inFlight = true;
    try {
      const { stdout } = await execFileAsync(oarBin(), ["panel", "--json"], {
        timeout: FETCH_TIMEOUT_MS,
        env: process.env,
        encoding: "utf8",
      });
      const snap = JSON.parse(stdout);
      const text = formatOarUsageStatus(snap);
      ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", text));
    } catch {
      ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", "OAR usage offline"));
    } finally {
      inFlight = false;
    }
  };

  const start = (ctx) => {
    lastCtx = ctx;
    stopTimer();
    if (!enabled || !ctx?.hasUI) {
      ctx?.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    void refresh(ctx);
    timer = setInterval(() => {
      if (lastCtx) void refresh(lastCtx);
    }, INTERVAL_MS);
  };

  pi.registerCommand("oar-usage", {
    description: "Toggle Grok/Codex remaining % in the footer",
    handler: async (_args, ctx) => {
      enabled = !enabled;
      start(ctx);
      ctx.ui.notify(`OAR usage footer: ${enabled ? "on" : "off"}`, "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    enabled = true;
    start(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    stopTimer();
    ctx?.ui.setStatus(STATUS_KEY, undefined);
  });
}
