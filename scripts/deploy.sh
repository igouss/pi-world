#!/bin/sh
# Deploy to the celld fleet. The fleet bucket and its service-account key come from the environment, with the
# defaults this project's fleet uses.
set -eu
: "${CELLD_BUCKET:=gs://pi-world-celld}"
: "${GOOGLE_APPLICATION_CREDENTIALS:=$HOME/.config/celld/pi-world.json}"
export GOOGLE_APPLICATION_CREDENTIALS
cd "$(dirname "$0")/.."
celld deploy --bucket "$CELLD_BUCKET"
