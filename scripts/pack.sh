#!/usr/bin/env bash
# Build a self-contained image and write a folder you can copy to another machine.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
tag="${TAG:-home-tour:latest}"
outdir="${1:-$root/dist/home-tour}"

mkdir -p "$outdir"
docker build -t "$tag" "$root"
docker save -o "$outdir/home-tour.tar" "$tag"

cat > "$outdir/docker-compose.yml" <<'EOF'
services:
  tour:
    image: home-tour:latest
    ports:
      - "${HOST_PORT:-8765}:8765"
    restart: unless-stopped
EOF

cat > "$outdir/deploy.sh" <<'EOF'
#!/bin/sh
set -eu
cd "$(dirname "$0")"
docker load -i home-tour.tar
HOST_PORT="${HOST_PORT:-8765}"
export HOST_PORT
docker compose up -d
echo "Tour:   http://127.0.0.1:${HOST_PORT}"
echo "Editor: http://127.0.0.1:${HOST_PORT}/admin"
EOF

chmod +x "$outdir/deploy.sh"
echo "Package: $outdir"
echo "Copy that folder to the other machine, then run ./deploy.sh"
