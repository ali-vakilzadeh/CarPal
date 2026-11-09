# Source from frontend/admin-console/ in Git Bash:  source tools/use-local-node.sh
# Copied from pwa/tools/use-local-node.sh (admin console GD-02, same as PWA GD-02): puts the project-local Node that
# backend/ installed (backend/.tools/node, 24.21.0) first on PATH. The system Node 20 stays for other projects.
# When it is missing, runs backend/tools/setup-local-node.mjs with the system Node first.
_carpal_backend_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../backend" 2>/dev/null && pwd)"
_carpal_node_dir="$_carpal_backend_dir/.tools/node"
if [ ! -e "$_carpal_node_dir/node" ] && [ ! -e "$_carpal_node_dir/node.exe" ] && [ ! -e "$_carpal_node_dir/bin/node" ]; then
  echo "Local Node not installed; running backend/tools/setup-local-node.mjs" >&2
  (cd "$_carpal_backend_dir" && node tools/setup-local-node.mjs)
fi
if [ ! -e "$_carpal_node_dir/node" ] && [ ! -e "$_carpal_node_dir/node.exe" ] && [ ! -e "$_carpal_node_dir/bin/node" ]; then
  echo "Local Node is still missing. Run: cd backend && node tools/setup-local-node.mjs" >&2
else
  [ -d "$_carpal_node_dir/bin" ] && _carpal_node_dir="$_carpal_node_dir/bin"
  export PATH="$_carpal_node_dir:$PATH"
  echo "Using $(node --version) from $_carpal_node_dir"
fi
unset _carpal_node_dir _carpal_backend_dir
