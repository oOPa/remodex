#!/usr/bin/env bash

# FILE: run-local-remodex.sh
# Purpose: Starts a local relay plus the public bridge for OSS and self-host workflows.
# Layer: developer utility
# Exports: none
# Depends on: node, npm, curl, relay/server.js, phodex-bridge/bin/remodex.js

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRIDGE_DIR="${ROOT_DIR}/phodex-bridge"
RELAY_DIR="${ROOT_DIR}/relay"
RELAY_SERVER_MODULE="${RELAY_DIR}/server.js"

RELAY_BIND_HOST="${RELAY_BIND_HOST:-0.0.0.0}"
RELAY_PORT="${RELAY_PORT:-9000}"
RELAY_HOSTNAME="${RELAY_HOSTNAME:-}"
RELAY_BRIDGE_HOST=""
RELAY_PID=""
BRIDGE_SERVICE_STARTED="false"
RELAY_SERVICE_STARTED="false"
KEEP_SERVICES_RUNNING="false"
LINUX_RELAY_SERVICE_NAME="com.remodex.local-relay.service"
REMODEX_STATE_DIR="${REMODEX_DEVICE_STATE_DIR:-${HOME}/.remodex}"
RELAY_STDOUT_LOG_PATH="${REMODEX_STATE_DIR}/logs/relay.stdout.log"
RELAY_STDERR_LOG_PATH="${REMODEX_STATE_DIR}/logs/relay.stderr.log"

log() {
  echo "[run-local-remodex] $*"
}

die() {
  echo "[run-local-remodex] $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: ./run-local-remodex.sh [options]

Options:
  --hostname HOSTNAME   Hostname or IP the iPhone should use to reach the relay
  --bind-host HOST      Interface/address the local relay should listen on
  --port PORT           Relay port to listen on
  --help                Show this help text

Defaults:
  --bind-host           0.0.0.0
  --port                9000
  --hostname            macOS LocalHostName.local, then first non-loopback IPv4, then hostname, then localhost
EOF
}

require_value() {
  local flag_name="$1"
  local remaining_args="$2"
  [[ "${remaining_args}" -ge 2 ]] || die "${flag_name} requires a value."
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --hostname)
        require_value "--hostname" "$#"
        RELAY_HOSTNAME="$2"
        shift 2
        ;;
      --bind-host)
        require_value "--bind-host" "$#"
        RELAY_BIND_HOST="$2"
        shift 2
        ;;
      --port)
        require_value "--port" "$#"
        RELAY_PORT="$2"
        shift 2
        ;;
      --help)
        usage
        exit 0
        ;;
      *)
        usage >&2
        die "Unknown argument: $1"
        ;;
    esac
  done
}

default_hostname() {
  if [[ -n "${RELAY_HOSTNAME}" ]]; then
    printf '%s\n' "${RELAY_HOSTNAME}"
    return
  fi

  if command -v scutil >/dev/null 2>&1; then
    local local_host_name
    local_host_name="$(scutil --get LocalHostName 2>/dev/null || true)"
    local_host_name="${local_host_name//[$'\r\n']}"
    if [[ -n "${local_host_name}" ]]; then
      printf '%s.local\n' "${local_host_name}"
      return
    fi
  fi

  local detected_ip
  detected_ip="$(node -e '
const os = require("node:os");

for (const addresses of Object.values(os.networkInterfaces())) {
  for (const address of addresses || []) {
    if (!address || address.internal || address.family !== "IPv4" || !address.address) {
      continue;
    }
    console.log(address.address);
    process.exit(0);
  }
}

process.exit(1);
' 2>/dev/null || true)"
  detected_ip="${detected_ip//[$'\r\n']}"
  if [[ -n "${detected_ip}" ]]; then
    printf '%s\n' "${detected_ip}"
    return
  fi

  local host_name
  host_name="$(hostname 2>/dev/null || true)"
  host_name="${host_name//[$'\r\n']}"
  if [[ -n "${host_name}" ]]; then
    printf '%s\n' "${host_name}"
    return
  fi

  printf 'localhost\n'
}

healthcheck_host() {
  case "${RELAY_BIND_HOST}" in
    ""|"0.0.0.0")
      printf '127.0.0.1\n'
      ;;
    "::")
      printf '[::1]\n'
      ;;
    *)
      printf '%s\n' "${RELAY_BIND_HOST}"
      ;;
  esac
}

cleanup() {
  if [[ "${KEEP_SERVICES_RUNNING}" == "true" ]]; then
    return
  fi

  if [[ "${BRIDGE_SERVICE_STARTED}" == "true" ]]; then
    (
      cd "${BRIDGE_DIR}"
      node ./bin/remodex.js stop >/dev/null 2>&1 || true
    )
  fi

  if [[ "${RELAY_SERVICE_STARTED}" == "true" ]]; then
    stop_linux_relay_service >/dev/null 2>&1 || true
    return
  fi

  if [[ -n "${RELAY_PID}" ]] && kill -0 "${RELAY_PID}" 2>/dev/null; then
    kill "${RELAY_PID}" 2>/dev/null || true
    wait "${RELAY_PID}" 2>/dev/null || true
  fi
}

require_command() {
  local command_name="$1"
  command -v "${command_name}" >/dev/null 2>&1 || die "Missing required command: ${command_name}"
}

ensure_node_version() {
  local node_version
  local node_major

  node_version="$(node -p 'process.versions.node' 2>/dev/null || true)"
  [[ -n "${node_version}" ]] || die "Unable to determine the installed Node.js version."

  node_major="${node_version%%.*}"
  [[ "${node_major}" =~ ^[0-9]+$ ]] || die "Unable to parse the installed Node.js version: ${node_version}"
  (( node_major >= 18 )) || die "Please use Node.js 18 or newer."
}

ensure_prerequisites() {
  require_command node
  require_command npm
  require_command curl
  ensure_node_version
  if [[ "$(uname -s 2>/dev/null || true)" == "Linux" ]]; then
    require_command systemctl
  fi
}

# Validates the advertised host before boot so the QR cannot point at another machine by mistake.
ensure_hostname_belongs_to_this_machine() {
  node -e '
const dns = require("node:dns");
const os = require("node:os");

const hostname = process.argv[1];
const localAddresses = new Set(["127.0.0.1", "::1"]);
for (const addresses of Object.values(os.networkInterfaces())) {
  for (const address of addresses || []) {
    if (address && typeof address.address === "string" && address.address) {
      localAddresses.add(address.address);
    }
  }
}

dns.lookup(hostname, { all: true }, (error, records) => {
  if (error || !Array.isArray(records) || records.length === 0) {
    process.exit(1);
    return;
  }

  const isLocal = records.some((record) => localAddresses.has(record.address));
  process.exit(isLocal ? 0 : 1);
});
' "${RELAY_HOSTNAME}" || die "The advertised hostname '${RELAY_HOSTNAME}' does not resolve back to this machine.
Pass --hostname with a LAN hostname or IP address that points to this machine so the iPhone can connect."
}

package_dependencies_installed() {
  local package_dir="$1"

  node -e '
const { createRequire } = require("node:module");
const fs = require("node:fs");
const path = require("node:path");

const packageDir = process.argv[1];
const packageJsonPath = path.join(packageDir, "package.json");
if (!fs.existsSync(packageJsonPath)) {
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
const dependencyNames = Object.keys(pkg.dependencies || {});
const requireFromPackage = createRequire(packageJsonPath);

for (const dependencyName of dependencyNames) {
  try {
    requireFromPackage.resolve(`${dependencyName}/package.json`);
  } catch {
    process.exit(1);
  }
}

process.exit(0);
' "${package_dir}"
}

ensure_package_dependencies() {
  local package_dir="$1"
  if package_dependencies_installed "${package_dir}"; then
    return
  fi

  log "Installing dependencies in ${package_dir}"
  (cd "${package_dir}" && npm install)
}

ensure_port_available() {
  if [[ "$(uname -s 2>/dev/null || true)" == "Linux" ]]; then
    if systemctl --user is-active --quiet "${LINUX_RELAY_SERVICE_NAME}"; then
      return
    fi
  fi

  if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"${RELAY_PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
    die "Port ${RELAY_PORT} is already in use. Stop the existing listener or rerun with --port."
  fi
}

wait_for_relay() {
  local attempt
  local probe_host

  probe_host="$(healthcheck_host)"
  for attempt in {1..20}; do
    if [[ -n "${RELAY_PID}" ]] && ! kill -0 "${RELAY_PID}" 2>/dev/null; then
      die "Relay process exited before becoming healthy."
    fi
    if curl --silent --fail "http://${probe_host}:${RELAY_PORT}/health" >/dev/null 2>&1; then
      return
    fi
    sleep 0.5
  done

  die "Relay did not become healthy on port ${RELAY_PORT}."
}

start_embedded_relay() {
  log "Starting relay on ${RELAY_BIND_HOST}:${RELAY_PORT}"

  RELAY_BIND_HOST="${RELAY_BIND_HOST}" \
  RELAY_PORT="${RELAY_PORT}" \
  RELAY_SERVER_MODULE="${RELAY_SERVER_MODULE}" \
  node <<'NODE' &
const { createRelayServer } = require(process.env.RELAY_SERVER_MODULE);

const host = process.env.RELAY_BIND_HOST || "0.0.0.0";
const port = Number.parseInt(process.env.RELAY_PORT || "9000", 10);
const { server } = createRelayServer();

server.listen(port, host, () => {
  console.log(`[relay] listening on http://${host}:${port}`);
});

function shutdown(signal) {
  console.log(`[relay] shutting down (${signal})`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
NODE

  RELAY_PID=$!
}

escape_systemd_path() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/ /\\ /g'
}

quote_systemd_value() {
  printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"
}

linux_relay_service_path() {
  printf '%s\n' "${HOME}/.config/systemd/user/${LINUX_RELAY_SERVICE_NAME}"
}

write_linux_relay_service_file() {
  local service_path
  local working_directory
  local stdout_path
  local stderr_path
  local quoted_node
  local quoted_server
  local quoted_home
  local quoted_path
  local quoted_bind_host
  local quoted_port

  service_path="$(linux_relay_service_path)"
  working_directory="$(escape_systemd_path "${ROOT_DIR}")"
  stdout_path="$(escape_systemd_path "${RELAY_STDOUT_LOG_PATH}")"
  stderr_path="$(escape_systemd_path "${RELAY_STDERR_LOG_PATH}")"
  quoted_node="$(quote_systemd_value "$(command -v node)")"
  quoted_server="$(quote_systemd_value "${RELAY_SERVER_MODULE}")"
  quoted_home="$(quote_systemd_value "${HOME}")"
  quoted_path="$(quote_systemd_value "${PATH}")"
  quoted_bind_host="$(quote_systemd_value "${RELAY_BIND_HOST}")"
  quoted_port="$(quote_systemd_value "${RELAY_PORT}")"

  mkdir -p "$(dirname "${service_path}")" "${REMODEX_STATE_DIR}/logs"
  cat > "${service_path}" <<EOF
[Unit]
Description=Remodex local relay
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${quoted_node} ${quoted_server}
Restart=on-failure
RestartSec=2
Environment=HOME=${quoted_home}
Environment=PATH=${quoted_path}
Environment=RELAY_BIND_HOST=${quoted_bind_host}
Environment=PORT=${quoted_port}
WorkingDirectory=${working_directory}
StandardOutput=append:${stdout_path}
StandardError=append:${stderr_path}

[Install]
WantedBy=default.target
EOF
}

start_linux_relay_service() {
  log "Starting background relay service on ${RELAY_BIND_HOST}:${RELAY_PORT}"
  write_linux_relay_service_file
  systemctl --user daemon-reload
  systemctl --user enable "${LINUX_RELAY_SERVICE_NAME}" >/dev/null
  systemctl --user restart "${LINUX_RELAY_SERVICE_NAME}"
  RELAY_SERVICE_STARTED="true"
}

stop_linux_relay_service() {
  systemctl --user disable --now "${LINUX_RELAY_SERVICE_NAME}" >/dev/null 2>&1 || true
}

start_relay() {
  if [[ "$(uname -s 2>/dev/null || true)" == "Linux" ]]; then
    start_linux_relay_service
    return
  fi

  start_embedded_relay
}

print_summary() {
  cat <<EOF
[run-local-remodex] Configuration
  Relay bind host : ${RELAY_BIND_HOST}
  Relay port      : ${RELAY_PORT}
  Relay hostname  : ${RELAY_HOSTNAME}
  Bridge host     : ${RELAY_BRIDGE_HOST}
  Relay URL       : ws://${RELAY_HOSTNAME}:${RELAY_PORT}/relay
EOF
}

start_bridge() {
  log "Starting bridge"
  cd "${BRIDGE_DIR}"
  # The bridge bakes REMODEX_RELAY into the pairing QR, so advertise the host
  # the iPhone can actually reach instead of the loopback health-check host.
  REMODEX_RELAY="ws://${RELAY_HOSTNAME}:${RELAY_PORT}/relay" node ./bin/remodex.js up
  BRIDGE_SERVICE_STARTED="true"
}

hold_open() {
  if [[ "$(uname -s 2>/dev/null || true)" == "Linux" ]]; then
    log "Local relay and bridge are running in the background."
    log "Use 'systemctl --user status ${LINUX_RELAY_SERVICE_NAME}' for the relay and 'node ./phodex-bridge/bin/remodex.js status --json' for the bridge."
    return
  fi

  log "Local relay is ready. Keep this terminal open while testing."
  log "Press Ctrl+C to stop both the local relay and the Remodex bridge service."
  wait "${RELAY_PID}"
}

trap cleanup EXIT INT TERM

parse_args "$@"
RELAY_HOSTNAME="$(default_hostname)"
RELAY_BRIDGE_HOST="$(healthcheck_host)"

ensure_prerequisites
ensure_package_dependencies "${BRIDGE_DIR}"
ensure_package_dependencies "${RELAY_DIR}"
ensure_hostname_belongs_to_this_machine
ensure_port_available
print_summary
start_relay
wait_for_relay
start_bridge
if [[ "$(uname -s 2>/dev/null || true)" == "Linux" ]]; then
  KEEP_SERVICES_RUNNING="true"
fi
hold_open
