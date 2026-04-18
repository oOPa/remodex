// FILE: linux-systemd-service.js
// Purpose: Owns Linux-only systemd service install/start/stop/status helpers for the background Remodex bridge.
// Layer: CLI service helper
// Exports: start/stop/status helpers plus the service runner used by `remodex up`.
// Depends on: child_process, fs, os, path, ./bridge, ./daemon-state, ./codex-desktop-refresher, ./qr, ./secure-device-state

const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { startBridge } = require("./bridge");
const { readBridgeConfig } = require("./codex-desktop-refresher");
const { printQR } = require("./qr");
const { resetBridgeDeviceState } = require("./secure-device-state");
const {
  clearBridgeStatus,
  clearPairingSession,
  ensureRemodexLogsDir,
  ensureRemodexStateDir,
  readBridgeStatus,
  readDaemonConfig,
  readPairingSession,
  resolveBridgeStderrLogPath,
  resolveBridgeStdoutLogPath,
  resolveRemodexStateDir,
  writeBridgeStatus,
  writeDaemonConfig,
  writePairingSession,
} = require("./daemon-state");

const SERVICE_NAME = "com.remodex.bridge.service";
const DEFAULT_PAIRING_WAIT_TIMEOUT_MS = 10_000;
const DEFAULT_PAIRING_WAIT_INTERVAL_MS = 200;

// Runs the bridge inside systemd while keeping QR rendering in the foreground CLI command.
function runLinuxBridgeService({
  env = process.env,
  platform = process.platform,
  startBridgeImpl = startBridge,
} = {}) {
  assertLinuxPlatform(platform);
  const config = readDaemonConfig({ env });
  if (!config?.relayUrl) {
    const message = "No relay URL configured for the Linux bridge service.";
    clearPairingSession({ env });
    writeBridgeStatus({
      state: "error",
      connectionStatus: "error",
      pid: process.pid,
      lastError: message,
    }, { env });
    console.error(`[remodex] ${message}`);
    return;
  }

  startBridgeImpl({
    config,
    printPairingQr: false,
    onPairingSession(pairingSession) {
      writePairingSession(pairingSession, { env });
    },
    onBridgeStatus(status) {
      writeBridgeStatus(status, { env });
    },
  });
}

// Prepares systemd user service state and optionally waits for the fresh pairing payload written by the service.
async function startLinuxBridgeService({
  env = process.env,
  platform = process.platform,
  fsImpl = fs,
  execFileSyncImpl = execFileSync,
  osImpl = os,
  nodePath = process.execPath,
  cliPath = path.resolve(__dirname, "..", "bin", "remodex.js"),
  waitForPairing = false,
  pairingTimeoutMs = DEFAULT_PAIRING_WAIT_TIMEOUT_MS,
  pairingPollIntervalMs = DEFAULT_PAIRING_WAIT_INTERVAL_MS,
} = {}) {
  assertLinuxPlatform(platform);
  const explicitConfig = readBridgeConfig({ env });
  const config = resolveDaemonServiceConfig(explicitConfig, { env, fsImpl });
  assertRelayConfigured(config);
  const startedAt = Date.now();

  writeDaemonConfig(config, { env, fsImpl });
  clearPairingSession({ env, fsImpl });
  clearBridgeStatus({ env, fsImpl });
  ensureRemodexStateDir({ env, fsImpl, osImpl });
  ensureRemodexLogsDir({ env, fsImpl, osImpl });

  const servicePath = writeSystemdServiceFile({
    env,
    fsImpl,
    osImpl,
    nodePath,
    cliPath,
  });
  restartSystemdService({
    env,
    execFileSyncImpl,
    serviceName: SERVICE_NAME,
  });

  if (!waitForPairing) {
    return {
      servicePath,
      pairingSession: null,
    };
  }

  const pairingSession = await waitForFreshPairingSession({
    env,
    fsImpl,
    startedAt,
    timeoutMs: pairingTimeoutMs,
    intervalMs: pairingPollIntervalMs,
  });
  return {
    servicePath,
    pairingSession,
  };
}

function stopLinuxBridgeService({
  env = process.env,
  platform = process.platform,
  execFileSyncImpl = execFileSync,
  fsImpl = fs,
} = {}) {
  assertLinuxPlatform(platform);
  disableAndStopSystemdService({
    env,
    execFileSyncImpl,
    serviceName: SERVICE_NAME,
    ignoreMissing: true,
  });
  clearPairingSession({ env, fsImpl });
  clearBridgeStatus({ env, fsImpl });
}

function resetLinuxBridgePairing({
  env = process.env,
  platform = process.platform,
  execFileSyncImpl = execFileSync,
  fsImpl = fs,
  resetBridgePairingImpl = resetBridgeDeviceState,
} = {}) {
  assertLinuxPlatform(platform);
  stopLinuxBridgeService({
    env,
    platform,
    execFileSyncImpl,
    fsImpl,
  });
  return resetBridgePairingImpl();
}

function getLinuxBridgeServiceStatus({
  env = process.env,
  platform = process.platform,
  execFileSyncImpl = execFileSync,
  fsImpl = fs,
} = {}) {
  assertLinuxPlatform(platform);
  const installed = fsImpl.existsSync(resolveSystemdServicePath({ env }));
  const active = isSystemdServiceActive({
    env,
    execFileSyncImpl,
    serviceName: SERVICE_NAME,
  });
  const enabled = isSystemdServiceEnabled({
    env,
    execFileSyncImpl,
    serviceName: SERVICE_NAME,
  });
  const mainPid = getSystemdServiceMainPid({
    env,
    execFileSyncImpl,
    serviceName: SERVICE_NAME,
  });

  return {
    unit: SERVICE_NAME,
    platform: "linux",
    installed,
    systemdActive: active,
    systemdEnabled: enabled,
    systemdPid: mainPid,
    daemonConfig: readDaemonConfig({ env, fsImpl }),
    bridgeStatus: readBridgeStatus({ env, fsImpl }),
    pairingSession: readPairingSession({ env, fsImpl }),
    stdoutLogPath: resolveBridgeStdoutLogPath({ env }),
    stderrLogPath: resolveBridgeStderrLogPath({ env }),
  };
}

function printLinuxBridgeServiceStatus(options = {}) {
  const status = getLinuxBridgeServiceStatus(options);
  const bridgeState = status.bridgeStatus?.state || "unknown";
  const connectionStatus = status.bridgeStatus?.connectionStatus || "unknown";
  const pairingCreatedAt = status.pairingSession?.createdAt || "none";
  console.log(`[remodex] Service unit: ${status.unit}`);
  console.log(`[remodex] Installed: ${status.installed ? "yes" : "no"}`);
  console.log(`[remodex] Systemd active: ${status.systemdActive ? "yes" : "no"}`);
  console.log(`[remodex] Systemd enabled: ${status.systemdEnabled ? "yes" : "no"}`);
  console.log(`[remodex] PID: ${status.systemdPid || status.bridgeStatus?.pid || "unknown"}`);
  console.log(`[remodex] Bridge state: ${bridgeState}`);
  console.log(`[remodex] Connection: ${connectionStatus}`);
  console.log(`[remodex] Pairing payload: ${pairingCreatedAt}`);
  console.log(`[remodex] Stdout log: ${status.stdoutLogPath}`);
  console.log(`[remodex] Stderr log: ${status.stderrLogPath}`);
}

function printLinuxBridgePairingQr({ pairingSession = null, env = process.env, fsImpl = fs } = {}) {
  const nextPairingSession = pairingSession || readPairingSession({ env, fsImpl });
  const pairingPayload = nextPairingSession?.pairingPayload;
  if (!pairingPayload) {
    throw new Error("The Linux bridge service did not publish a pairing QR yet.");
  }

  printQR(pairingPayload);
}

function writeSystemdServiceFile({
  env = process.env,
  fsImpl = fs,
  osImpl = os,
  nodePath = process.execPath,
  cliPath = path.resolve(__dirname, "..", "bin", "remodex.js"),
} = {}) {
  const servicePath = resolveSystemdServicePath({ env, osImpl });
  const stateDir = resolveRemodexStateDir({ env, osImpl });
  const stdoutLogPath = resolveBridgeStdoutLogPath({ env, osImpl });
  const stderrLogPath = resolveBridgeStderrLogPath({ env, osImpl });
  const homeDir = env.HOME || osImpl.homedir();

  const serialized = buildSystemdServiceFile({
    homeDir,
    pathEnv: env.PATH || "",
    nodePath,
    cliPath,
    stateDir,
    stdoutLogPath,
    stderrLogPath,
  });

  fsImpl.mkdirSync(path.dirname(servicePath), { recursive: true });
  fsImpl.writeFileSync(servicePath, serialized, "utf8");
  return servicePath;
}

function buildSystemdServiceFile({
  homeDir,
  pathEnv,
  nodePath,
  cliPath,
  stateDir,
  stdoutLogPath,
  stderrLogPath,
}) {
  const quotedNode = quoteSystemdValue(nodePath);
  const quotedCli = quoteSystemdValue(cliPath);
  const quotedPath = quoteSystemdValue(homeDir);
  const quotedEnvPath = quoteSystemdValue(pathEnv);
  const quotedStateDir = quoteSystemdValue(stateDir);
  const workingDirectory = escapeSystemdPath(homeDir);
  const stdoutPath = escapeSystemdPath(stdoutLogPath);
  const stderrPath = escapeSystemdPath(stderrLogPath);

  return `[Unit]
Description=Remodex background bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${quotedNode} ${quotedCli} run-service
Restart=on-failure
RestartSec=2
Environment=HOME=${quotedPath}
Environment=PATH=${quotedEnvPath}
Environment=REMODEX_DEVICE_STATE_DIR=${quotedStateDir}
WorkingDirectory=${workingDirectory}
StandardOutput=append:${stdoutPath}
StandardError=append:${stderrPath}

[Install]
WantedBy=default.target
`;
}

function restartSystemdService({
  env = process.env,
  execFileSyncImpl = execFileSync,
  serviceName = SERVICE_NAME,
} = {}) {
  ensureSystemdAvailable({ env, execFileSyncImpl });
  execFileSyncImpl("systemctl", [
    "--user",
    "daemon-reload",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  execFileSyncImpl("systemctl", [
    "--user",
    "enable",
    serviceName,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  execFileSyncImpl("systemctl", [
    "--user",
    "restart",
    serviceName,
  ], { stdio: ["ignore", "ignore", "pipe"] });
}

function disableAndStopSystemdService({
  env = process.env,
  execFileSyncImpl = execFileSync,
  serviceName = SERVICE_NAME,
  ignoreMissing = false,
} = {}) {
  try {
    ensureSystemdAvailable({ env, execFileSyncImpl });
    execFileSyncImpl("systemctl", ["--user", "disable", "--now", serviceName], { stdio: ["ignore", "ignore", "pipe"] });
    return;
  } catch (error) {
    if (ignoreMissing && isMissingSystemdError(error, serviceName)) {
      return;
    }
    throw error;
  }
}

function isSystemdServiceActive({
  env = process.env,
  execFileSyncImpl = execFileSync,
  serviceName = SERVICE_NAME,
}) {
  try {
    ensureSystemdAvailable({ env, execFileSyncImpl });
    execFileSyncImpl("systemctl", ["--user", "is-active", "--quiet", serviceName], { stdio: ["ignore", "ignore", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

function isSystemdServiceEnabled({
  env = process.env,
  execFileSyncImpl = execFileSync,
  serviceName = SERVICE_NAME,
}) {
  try {
    ensureSystemdAvailable({ env, execFileSyncImpl });
    execFileSyncImpl("systemctl", ["--user", "is-enabled", "--quiet", serviceName], { stdio: ["ignore", "ignore", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

function getSystemdServiceMainPid({
  env = process.env,
  execFileSyncImpl = execFileSync,
  serviceName = SERVICE_NAME,
}) {
  try {
    ensureSystemdAvailable({ env, execFileSyncImpl });
    const output = execFileSyncImpl(
      "systemctl",
      ["--user", "show", serviceName, "-p", "MainPID", "--value"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const pid = Number.parseInt(String(output).trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function waitForFreshPairingSession({
  env = process.env,
  fsImpl = fs,
  startedAt = Date.now(),
  timeoutMs = DEFAULT_PAIRING_WAIT_TIMEOUT_MS,
  intervalMs = DEFAULT_PAIRING_WAIT_INTERVAL_MS,
} = {}) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    const pairingSession = readPairingSession({ env, fsImpl });
    const createdAt = Date.parse(pairingSession?.createdAt || "");
    if (pairingSession?.pairingPayload && Number.isFinite(createdAt) && createdAt >= startedAt) {
      return pairingSession;
    }
    await sleep(intervalMs);
  }

  throw new Error(
    `Timed out waiting for the Linux bridge service to publish a pairing QR. `
    + `Check ${resolveBridgeStderrLogPath({ env })}.`
  );
}

function resolveSystemdServicePath({ env = process.env, osImpl = os } = {}) {
  const homeDir = env.HOME || osImpl.homedir();
  return path.join(homeDir, ".config", "systemd", "user", `${SERVICE_NAME}`);
}

function assertLinuxPlatform(platform = process.platform) {
  if (platform !== "linux") {
    throw new Error("Linux bridge service management is only available on Linux.");
  }
}

function assertRelayConfigured(config) {
  if (typeof config?.relayUrl === "string" && config.relayUrl.trim()) {
    return;
  }
  throw new Error("No relay URL configured. Run ./run-local-remodex.sh or set REMODEX_RELAY before enabling the Linux bridge service.");
}

function resolveDaemonServiceConfig(config, { env = process.env, fsImpl = fs } = {}) {
  if (typeof config?.relayUrl === "string" && config.relayUrl.trim()) {
    return config;
  }

  return readDaemonConfig({ env, fsImpl }) || config;
}

function ensureSystemdAvailable({ env = process.env, execFileSyncImpl = execFileSync }) {
  try {
    execFileSyncImpl("systemctl", ["--version"], { encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] });
  } catch (error) {
    throw new Error(`systemctl is required for the Linux bridge service: ${(error && error.message) || "unknown error"}`);
  }
}

function isMissingSystemdError(error, serviceName = SERVICE_NAME) {
  if (error?.code === "ENOENT") {
    return true;
  }

  const combined = [
    error?.message,
    error?.stderr?.toString?.("utf8"),
    error?.stdout?.toString?.("utf8"),
  ].filter(Boolean).join("\n").toLowerCase();
  const hasUnit = combined.includes(`unit "${serviceName}"`) || combined.includes(`unit ${serviceName}`);
  return combined.includes("could not be found")
    || combined.includes("could not find")
    || (hasUnit && combined.includes("not found"))
    || (hasUnit && combined.includes("does not exist"))
    || (hasUnit && combined.includes("not loaded"))
    || combined.includes("no such unit");
}

function quoteSystemdValue(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

function escapeSystemdPath(value) {
  return String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll(" ", "\\ ");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  buildSystemdServiceFile,
  getLinuxBridgeServiceStatus,
  printLinuxBridgePairingQr,
  printLinuxBridgeServiceStatus,
  resetLinuxBridgePairing,
  resolveSystemdServicePath,
  runLinuxBridgeService,
  resolveDaemonServiceConfig,
  startLinuxBridgeService,
  stopLinuxBridgeService,
};
