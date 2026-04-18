// FILE: linux-systemd-service.test.js
// Purpose: Verifies Linux systemd unit generation and lifecycle helpers for the background bridge.
// Layer: Unit test
// Exports: node:test suite

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  buildSystemdServiceFile,
  getLinuxBridgeServiceStatus,
  resetLinuxBridgePairing,
  resolveSystemdServicePath,
  runLinuxBridgeService,
  stopLinuxBridgeService,
} = require("../src/linux-systemd-service");
const {
  clearBridgeStatus,
  clearPairingSession,
  writeBridgeStatus,
  writePairingSession,
  writeDaemonConfig,
  readBridgeStatus,
  readPairingSession,
} = require("../src/daemon-state");

test("buildSystemdServiceFile points systemd at run-service with remodex state paths", () => {
  const service = buildSystemdServiceFile({
    homeDir: "/Users/tester",
    pathEnv: "/usr/local/bin:/usr/bin",
    stateDir: "/Users/tester/.remodex",
    stdoutLogPath: "/Users/tester/.remodex/logs/bridge.stdout.log",
    stderrLogPath: "/Users/tester/.remodex/logs/bridge.stderr.log",
    nodePath: "/usr/local/bin/node",
    cliPath: "/tmp/remodex/bin/remodex.js",
  });

  assert.match(service, /Description=Remodex background bridge/);
  assert.match(service, /WantedBy=default.target/);
  assert.match(service, /Type=simple/);
  assert.match(service, /ExecStart="\/usr\/local\/bin\/node" "\/tmp\/remodex\/bin\/remodex\.js" run-service/);
  assert.match(service, /Environment=HOME="\/Users\/tester"/);
  assert.match(service, /REMODEX_DEVICE_STATE_DIR="\/Users\/tester\/\.remodex"/);
});

test("resolveSystemdServicePath writes into the user's XDG systemd user directory", () => {
  assert.equal(
    resolveSystemdServicePath({
      env: { HOME: "/Users/tester" },
      osImpl: { homedir: () => "/Users/fallback" },
    }),
    path.join("/Users/tester", ".config", "systemd", "user", "com.remodex.bridge.service"),
  );
});

test("stopLinuxBridgeService clears stale pairing and status files", () => {
  withTempDaemonEnv(() => {
    writePairingSession({ sessionId: "session-1" });
    writeBridgeStatus({ state: "running", connectionStatus: "connected" });

    stopLinuxBridgeService({
      platform: "linux",
      execFileSyncImpl() {
        const error = new Error("Could not find service");
        error.stderr = Buffer.from("Unit com.remodex.bridge.service not found");
        throw error;
      },
    });

    assert.equal(readPairingSession(), null);
    assert.equal(readBridgeStatus(), null);
  });
});

test("stopLinuxBridgeService propagates unexpected service-manager failures", () => {
  withTempDaemonEnv(() => {
    assert.throws(
      () => {
        stopLinuxBridgeService({
          platform: "linux",
          execFileSyncImpl() {
            const error = new Error("Permission denied");
            error.stderr = Buffer.from("Permission denied");
            throw error;
          },
        });
      },
      /Permission denied/,
    );
  });
});

test("runLinuxBridgeService records a clean error state instead of throwing when daemon config is missing", () => {
  withTempDaemonEnv(() => {
    writePairingSession({ pairingPayload: { sessionId: "stale-session" } });

    assert.doesNotThrow(() => {
      runLinuxBridgeService({ env: process.env });
    });

    assert.equal(readPairingSession(), null);
    const status = readBridgeStatus();
    assert.equal(status?.state, "error");
    assert.equal(status?.connectionStatus, "error");
    assert.equal(status?.pid, process.pid);
    assert.equal(status?.lastError, "No relay URL configured for the Linux bridge service.");
  });
});

test("runLinuxBridgeService persists the pairing session published by startBridge", () => {
  withTempDaemonEnv(() => {
    writeDaemonConfig({ relayUrl: "ws://127.0.0.1:9000/relay" });

    runLinuxBridgeService({
      env: process.env,
      platform: "linux",
      startBridgeImpl(options) {
        options.onPairingSession?.({
          pairingPayload: { sessionId: "session-linux" },
          pairingCode: "ABC123",
        });
        options.onBridgeStatus?.({
          state: "running",
          connectionStatus: "connected",
          pid: 4321,
          lastError: "",
        });
      },
    });

    const pairingSession = readPairingSession();
    assert.equal(pairingSession?.pairingPayload?.sessionId, "session-linux");
    assert.equal(pairingSession?.pairingCode, "ABC123");
    const status = readBridgeStatus();
    assert.equal(status?.state, "running");
    assert.equal(status?.connectionStatus, "connected");
    assert.equal(status?.pid, 4321);
  });
});

test("getLinuxBridgeServiceStatus combines daemon metadata and runtime status", () => {
  withTempDaemonEnv(({ rootDir }) => {
    writeDaemonConfig({ relayUrl: "ws://127.0.0.1:9000/relay" });
    writePairingSession({ sessionId: "session-2" });
    writeBridgeStatus({ state: "running", connectionStatus: "connected", pid: 55 });
    fs.mkdirSync(path.join(rootDir, ".config", "systemd", "user"), { recursive: true });
    fs.writeFileSync(resolveSystemdServicePath({ env: { HOME: rootDir } }), "service");

    const status = getLinuxBridgeServiceStatus({
      platform: "linux",
      env: { HOME: rootDir, REMODEX_DEVICE_STATE_DIR: rootDir },
      execFileSyncImpl(command, args) {
        if (args[0] === "--version") {
          return "systemd 252 (252)";
        }
        if (args[1] === "is-active") {
          return "";
        }
        if (args[1] === "is-enabled") {
          return "";
        }
        return "123";
      },
    });

    assert.equal(status.platform, "linux");
    assert.equal(status.installed, true);
    assert.equal(status.systemdActive, true);
    assert.equal(status.systemdEnabled, true);
    assert.equal(status.systemdPid, 123);
    assert.equal(status.daemonConfig?.relayUrl, "ws://127.0.0.1:9000/relay");
    assert.equal(status.bridgeStatus?.connectionStatus, "connected");
    assert.equal(status.pairingSession?.pairingPayload?.sessionId, "session-2");
  });
});

test("resetLinuxBridgePairing clears service state before erasing trust state", () => {
  withTempDaemonEnv(() => {
    writePairingSession({ sessionId: "session-reset" });
    writeBridgeStatus({ state: "running", connectionStatus: "connected" });

    let stopCalls = 0;
    let resetCalls = 0;
    const result = resetLinuxBridgePairing({
      platform: "linux",
      execFileSyncImpl() {
        stopCalls += 1;
        const error = new Error("No such unit com.remodex.bridge.service");
        error.stderr = Buffer.from("No such unit com.remodex.bridge.service");
        throw error;
      },
      resetBridgePairingImpl() {
        resetCalls += 1;
        return { hadState: true };
      },
    });

    assert.equal(stopCalls, 1);
    assert.equal(resetCalls, 1);
    assert.equal(result.hadState, true);
    assert.equal(readPairingSession(), null);
    assert.equal(readBridgeStatus(), null);
  });
});

function withTempDaemonEnv(run) {
  const previousDir = process.env.REMODEX_DEVICE_STATE_DIR;
  const previousHome = process.env.HOME;
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "remodex-linux-systemd-"));
  process.env.REMODEX_DEVICE_STATE_DIR = rootDir;
  process.env.HOME = rootDir;

  try {
    clearPairingSession({});
    clearBridgeStatus({});
    return run({ rootDir });
  } finally {
    if (previousDir === undefined) {
      delete process.env.REMODEX_DEVICE_STATE_DIR;
    } else {
      process.env.REMODEX_DEVICE_STATE_DIR = previousDir;
    }
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}
