#!/bin/bash
# Usage: SKY_HOST=user@host ./deploy.sh
# Deploys Sky over Renton to ~/adsb on that host (receiver + app). Keeps ~/adsb/.env (LAT/LON) and state/.
set -euo pipefail
cd "$(dirname "$0")"
HOST=${SKY_HOST:?set SKY_HOST=user@host}
rsync -a --delete web/ "$HOST:adsb/web/"
rsync -a --delete api/ "$HOST:adsb/api/"
rsync -a --inplace nginx.conf docker-compose.yml "$HOST:adsb/"   # in place: single-file bind mounts keep the old inode otherwise
ssh "$HOST" 'cd ~/adsb && mkdir -p state && docker compose up -d --remove-orphans 2>&1 | tail -4 && docker restart sky-api >/dev/null && docker exec sky-web nginx -s reload'
