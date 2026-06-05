#!/usr/bin/env bash
set -euo pipefail

# Bootstrap a fresh Debian/Ubuntu VM for hosted vibly-indexer deployment.
# It installs Docker + Compose, prepares /opt/vibly/vibly-indexer,
# clones or updates the repo, and writes a runtime env file consumed by
# docker compose on later deploys.

if [[ "${EUID}" -ne 0 ]]; then
  echo "[bootstrap] please run as root (or via sudo)" >&2
  exit 1
fi

VIBLY_USER="${VIBLY_USER:-${SUDO_USER:-$(id -un)}}"
REPO_URL="${REPO_URL:-}"
REPO_BRANCH="${REPO_BRANCH:-main}"
REPO_DIR="${REPO_DIR:-/opt/vibly/vibly-indexer}"
RUNTIME_ENV_PATH="${RUNTIME_ENV_PATH:-${REPO_DIR}/deploy/indexer.env}"
CHAIN_ENDPOINT="${CHAIN_ENDPOINT:-ws://127.0.0.1:9944}"
CHAIN_ID="${CHAIN_ID:-substrate:vibly-solo}"
START_BLOCK="${START_BLOCK:-1}"
INSTALL_DOCKER="${INSTALL_DOCKER:-true}"
ENABLE_DOCKER_ON_BOOT="${ENABLE_DOCKER_ON_BOOT:-true}"

if [[ -z "${REPO_URL}" ]]; then
  echo "[bootstrap] REPO_URL is required, for example:" >&2
  echo "  REPO_URL=git@github.com:your-org/vibly-indexer.git sudo ./bootstrap-vibly-indexer-vm.sh" >&2
  exit 1
fi

install_base_packages() {
  echo "[bootstrap] installing base packages"
  apt-get update
  apt-get install -y ca-certificates curl git gnupg lsb-release
}

install_docker_engine() {
  if command -v docker >/dev/null 2>&1; then
    echo "[bootstrap] docker already installed"
    return
  fi

  echo "[bootstrap] installing docker engine + compose plugin"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/"$(. /etc/os-release && echo "${ID}")"/gpg \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg

  . /etc/os-release
  echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/${ID} ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list

  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
}

prepare_repo_dir() {
  echo "[bootstrap] preparing ${REPO_DIR}"
  install -d -m 0755 "$(dirname "${REPO_DIR}")"
  install -d -m 0755 "${REPO_DIR}"
  install -d -m 0755 "$(dirname "${RUNTIME_ENV_PATH}")"
}

sync_repo() {
  if [[ ! -d "${REPO_DIR}/.git" ]]; then
    echo "[bootstrap] cloning ${REPO_URL} into ${REPO_DIR}"
    rm -rf "${REPO_DIR}"
    git clone "${REPO_URL}" "${REPO_DIR}"
  fi

  echo "[bootstrap] syncing repository branch ${REPO_BRANCH}"
  git -C "${REPO_DIR}" fetch --all --tags
  git -C "${REPO_DIR}" checkout "${REPO_BRANCH}"
  git -C "${REPO_DIR}" pull --ff-only
}

write_runtime_env() {
  echo "[bootstrap] writing ${RUNTIME_ENV_PATH}"
  cat > "${RUNTIME_ENV_PATH}" <<EOF
ENDPOINT=${CHAIN_ENDPOINT}
CHAIN_ID=${CHAIN_ID}
START_BLOCK=${START_BLOCK}
EOF
}

configure_permissions() {
  echo "[bootstrap] configuring ownership for ${VIBLY_USER}"
  chown -R "${VIBLY_USER}:${VIBLY_USER}" "$(dirname "${REPO_DIR}")"
  usermod -aG docker "${VIBLY_USER}" || true
}

start_docker() {
  if [[ "${ENABLE_DOCKER_ON_BOOT}" == "true" ]]; then
    systemctl enable docker
  fi
  systemctl restart docker
}

print_next_steps() {
  cat <<EOF
[bootstrap] complete

Remote directory: ${REPO_DIR}
Runtime env file: ${RUNTIME_ENV_PATH}

Next deploy command on this VM:
  cd ${REPO_DIR}
  export \$(grep -v '^#' ${RUNTIME_ENV_PATH} | xargs)
  npm ci
  npm run build
  docker compose pull
  docker compose up -d --remove-orphans

Or from vibly-e2e-lab:
  GCP_VIBLY_INDEXER_VM=<vm> \\
  GCP_VIBLY_INDEXER_REMOTE_DIR=${REPO_DIR} \\
  pnpm deploy:gcp -- --only=vibly-indexer
EOF
}

install_base_packages
if [[ "${INSTALL_DOCKER}" == "true" ]]; then
  install_docker_engine
fi
prepare_repo_dir
sync_repo
write_runtime_env
configure_permissions
start_docker
print_next_steps
