# Source from backend/ in Git Bash:  source tools/use-local-node.sh
# Puts the project-local Node (installed by tools/setup-local-node.mjs) first on PATH.
_carpal_node_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.tools/node" 2>/dev/null && pwd)"
if [ -z "$_carpal_node_dir" ] || [ ! -e "$_carpal_node_dir/node" ] && [ ! -e "$_carpal_node_dir/node.exe" ] && [ ! -e "$_carpal_node_dir/bin/node" ]; then
  echo "Local Node not installed. Run: node tools/setup-local-node.mjs" >&2
else
  [ -d "$_carpal_node_dir/bin" ] && _carpal_node_dir="$_carpal_node_dir/bin"
  export PATH="$_carpal_node_dir:$PATH"
  echo "Using $(node --version) from $_carpal_node_dir"
fi
unset _carpal_node_dir
