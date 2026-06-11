#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="vibly-496706"
REGION="asia-east1"
SERVICE="vibly-coordinator"
REPOSITORY="cloud-run-source-deploy"
IMAGE="asia-east1-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/${SERVICE}"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
COORDINATOR="${ROOT}/vibly-coordinator"

COMMIT="$(git -C "$COORDINATOR" rev-parse --short HEAD)"
BUILD_CONTEXT="$(mktemp -d "${TMPDIR:-/tmp}/vibly-coordinator-build.XXXXXX")"
trap 'rm -rf "$BUILD_CONTEXT"' EXIT

rsync_excludes=(
  --exclude ".git/"
  --exclude "node_modules/"
  --exclude "build/"
  --exclude ".next/"
  --exclude "coverage/"
  --exclude ".turbo/"
  --exclude ".cache/"
  --exclude "target/"
  --exclude "*.log"
  --exclude "*.sqlite"
  --exclude "*.sqlite3"
)

for path in \
  concord \
  vibly-coordinator \
  vibly-coordinator-http-contract \
  vibly-client \
  vibly-console
do
  rsync -a "${rsync_excludes[@]}" "${ROOT}/${path}/" "${BUILD_CONTEXT}/${path}/"
done

echo "[deploy] Docker build context: ${BUILD_CONTEXT}"
du -sh "$BUILD_CONTEXT"

docker build \
  --platform linux/amd64 \
  -f "${BUILD_CONTEXT}/vibly-coordinator/Dockerfile" \
  -t "${IMAGE}:${COMMIT}" \
  -t "${IMAGE}:latest" \
  "$BUILD_CONTEXT"

docker push "${IMAGE}:${COMMIT}"
docker push "${IMAGE}:latest"

gcloud run deploy "$SERVICE" \
  --image "${IMAGE}:${COMMIT}" \
  --region "$REGION" \
  --project "$PROJECT_ID" \
  --allow-unauthenticated \
  --env-vars-file "${COORDINATOR}/cloud-run.env.yaml" \
  --add-cloudsql-instances "vibly-496706:asia-southeast1:lumen-testnet-db"
