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

cd "$ROOT"

docker build \
  --platform linux/amd64 \
  -f vibly-coordinator/Dockerfile \
  -t "${IMAGE}:${COMMIT}" \
  -t "${IMAGE}:latest" \
  .

docker push "${IMAGE}:${COMMIT}"
docker push "${IMAGE}:latest"

gcloud run deploy "$SERVICE" \
  --image "${IMAGE}:${COMMIT}" \
  --region "$REGION" \
  --project "$PROJECT_ID" \
  --allow-unauthenticated \
  --env-vars-file "${COORDINATOR}/cloud-run.env.yaml" \
  --add-cloudsql-instances "vibly-496706:asia-southeast1:lumen-testnet-db"