#!/usr/bin/env bash
# The whole update in one command, after uploading the new code to the staging folder:
#   0-predeploy (stop + backup) -> 1-sync -> 2-build -> 3-permissions -> 4-start
#
#   sudo bash /home/root/staging/backend/deploy/update.sh [2-build.sh options, e.g. --quick]
#
# Runs the scripts from the staging copy, so a change to the scripts themselves takes effect
# in the same update. Stops at the first failure; the service then stays stopped (deploy.md "Rollback").
set -Eeuo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
find "$here" -maxdepth 1 -name '*.sh' -exec sed -i 's/\r$//' {} +

bash "$here/0-predeploy.sh"
bash "$here/1-sync.sh"
# From here on, the freshly synced scripts in the production folder run.
source "$here/lib.sh"
bash "$BACKEND_DIR/deploy/2-build.sh" "$@"
bash "$BACKEND_DIR/deploy/3-permissions.sh"
bash "$BACKEND_DIR/deploy/4-start.sh"
echo "Update complete."
