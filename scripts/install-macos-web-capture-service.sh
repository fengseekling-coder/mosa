#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  printf 'error: this installer is for macOS only\n' >&2
  exit 1
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
node_bin="$(command -v node || true)"
[[ -n "$node_bin" && -x "$node_bin" ]] || { printf 'error: node is required\n' >&2; exit 1; }

label="com.azhuilab.mosa.web-capture"
domain="gui/$(id -u)"
plist_dir="$HOME/Library/LaunchAgents"
plist="$plist_dir/$label.plist"
log_dir="$HOME/Library/Logs/MOSA"
env_file="$HOME/.config/mosa/web-capture.env"
supervisor="$repo_root/scripts/macos-web-capture-supervisor.mjs"

[[ -r "$env_file" ]] || { printf 'error: missing MOSA Web Capture environment file: %s\n' "$env_file" >&2; exit 1; }
[[ -r "$supervisor" ]] || { printf 'error: missing supervisor: %s\n' "$supervisor" >&2; exit 1; }

mkdir -p "$plist_dir" "$log_dir"
temporary_plist="$plist.tmp.$$"
cleanup() { rm -f -- "$temporary_plist"; }
trap cleanup EXIT

xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g'
}

escaped_home="$(xml_escape "$HOME")"
escaped_repo="$(xml_escape "$repo_root")"
escaped_node="$(xml_escape "$node_bin")"
escaped_env="$(xml_escape "$env_file")"
escaped_supervisor="$(xml_escape "$supervisor")"
escaped_stdout="$(xml_escape "$log_dir/web-capture.out.log")"
escaped_stderr="$(xml_escape "$log_dir/web-capture.err.log")"
escaped_path="$(xml_escape "$(dirname "$node_bin"):/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")"

cat > "$temporary_plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-c</string>
    <string>set -eu; set -a; source &quot;$escaped_env&quot;; set +a; exec &quot;$escaped_node&quot; &quot;$escaped_supervisor&quot;</string>
  </array>
  <key>WorkingDirectory</key><string>$escaped_repo</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>$escaped_home</string>
    <key>PATH</key><string>$escaped_path</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$escaped_stdout</string>
  <key>StandardErrorPath</key><string>$escaped_stderr</string>
</dict>
</plist>
EOF

plutil -lint "$temporary_plist" >/dev/null
chmod 0644 "$temporary_plist"
mv -f -- "$temporary_plist" "$plist"

launchctl bootout "$domain/$label" >/dev/null 2>&1 || true
for attempt in {1..40}; do
  if ! launchctl print "$domain/$label" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done
if launchctl print "$domain/$label" >/dev/null 2>&1; then
  printf 'error: %s did not finish unloading from %s\n' "$label" "$domain" >&2
  exit 1
fi

bootstrap_ok=0
for attempt in {1..8}; do
  if launchctl bootstrap "$domain" "$plist"; then
    bootstrap_ok=1
    break
  fi
  sleep 0.25
done
[[ "$bootstrap_ok" -eq 1 ]] || { printf 'error: could not bootstrap %s\n' "$label" >&2; exit 1; }
launchctl enable "$domain/$label"
launchctl kickstart "$domain/$label"

printf 'Installed %s with cooperative MOSA runtime supervision.\n' "$label"
printf 'plist: %s\n' "$plist"
printf 'supervisor: %s\n' "$supervisor"
