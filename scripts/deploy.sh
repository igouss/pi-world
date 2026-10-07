#!/bin/sh
# Deploy to the celld fleet. The fleet bucket and its service-account key come from the environment, with the
# defaults this project's fleet uses.
set -eu
: "${CELLD_BUCKET:=gs://pi-world-celld}"
: "${GOOGLE_APPLICATION_CREDENTIALS:=$HOME/.config/celld/pi-world.json}"
export GOOGLE_APPLICATION_CREDENTIALS
cd "$(dirname "$0")/.."
# Stamp the build: the git revision, marked dirty when the working tree has changes.
build="$(git describe --always --dirty)"
node -e '
const fs = require("node:fs");
const config = fs.readFileSync("wrangler.jsonc", "utf8").replace("\"BUILD\": \"\\\"dev\\\"\"", `"BUILD": ${JSON.stringify(JSON.stringify(process.argv[1]))}`);
if (!config.includes(process.argv[1])) throw new Error("wrangler.jsonc has no BUILD define to stamp");
fs.writeFileSync("wrangler.deploy.jsonc", config);
' "$build"
celld deploy wrangler.deploy.jsonc --bucket "$CELLD_BUCKET"
rm wrangler.deploy.jsonc
