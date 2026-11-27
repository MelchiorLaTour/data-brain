# compat.sh — sourced near the top of bin/ scripts. macOS: does nothing.
# Linux (including Windows WSL 2): puts bin/compat first on PATH so the BSD forms of
# stat / date / shasum used throughout bin/ work unchanged. See bin/compat/*.
if [ "$(uname -s)" = Linux ]; then
  _nb_compat="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/compat"
  case ":$PATH:" in *":$_nb_compat:"*) ;; *) PATH="$_nb_compat:$PATH"; export PATH ;; esac
  unset _nb_compat
fi
