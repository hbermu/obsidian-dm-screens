#!/usr/bin/env bash
# Installs the map-screen start page on an Android TV running Fully Kiosk Browser, over ADB.
# See README.md in this directory for the one-time steps on the TV.
#
#   install.sh --tv 192.0.2.50 --server "Living room PC=192.0.2.20:3000:<token>" [--server ...] [--fully-password <pw>]
#
#   --tv HOST[:PORT]       the TV's network debugging address (port 5555 by default)
#   --server LABEL=HOST[:PORT]:TOKEN
#                          a computer that runs the DM Screen server, in the order the TV tries them;
#                          TOKEN is the k= value of its Map Screen link, PORT defaults to 3000
#   --fully-password PW    Fully's Remote Admin password: also applies the Fully settings over its REST API
#                          (Remote Admin is a Fully PLUS feature); without it the script prints them to set by hand
#
# Env: ADB (default: adb on PATH).
set -euo pipefail

FULLY=de.ozerov.fully
FILES=/sdcard/Android/data/$FULLY/files
PAGE_URL=file://$FILES/start.html
ADB="${ADB:-adb}"
HERE="$(cd "$(dirname "$0")" && pwd)"

die() { echo "error: $*" >&2; exit 1; }
usage() { sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-2}"; }

# JSON string for an inline <script>: escapes quotes and backslashes, and "<" so no value can close the tag.
json_str() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//</\\u003c}
  printf '"%s"' "$s"
}

tv="" password="" servers=""
while [ $# -gt 0 ]; do
  case "$1" in
    --tv) tv=${2:-}; shift 2 ;;
    --fully-password) password=${2:-}; shift 2 ;;
    --server)
      arg=${2:-}; shift 2
      case "$arg" in *=*) ;; *) die "--server needs LABEL=HOST[:PORT]:TOKEN, got: $arg" ;; esac
      label=${arg%%=*} rest=${arg#*=}
      IFS=: read -r host p2 p3 <<<"$rest"
      if [ -n "${p3:-}" ]; then port=$p2 token=$p3; else port=3000 token=${p2:-}; fi
      [ -n "$label" ] && [ -n "$host" ] && [ -n "$token" ] || die "--server needs LABEL=HOST[:PORT]:TOKEN, got: $arg"
      case "$port" in ''|*[!0-9]*) die "port must be a number in: $arg" ;; esac
      servers="$servers${servers:+,}{\"label\":$(json_str "$label"),\"host\":$(json_str "$host"),\"port\":$port,\"token\":$(json_str "$token")}"
      ;;
    -h|--help) usage 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done
[ -n "$tv" ] || usage
[ -n "$servers" ] || die "give at least one --server"
command -v "$ADB" >/dev/null || die "adb not found; install Android platform-tools or set ADB=/path/to/adb"
case "$tv" in *:*) target=$tv ;; *) target=$tv:5555 ;; esac

echo "Connecting to $target — accept the debugging prompt on the TV if it appears"
"$ADB" connect "$target" >/dev/null || true
for _ in $(seq 1 30); do
  state=$("$ADB" -s "$target" get-state 2>/dev/null || true)
  [ "$state" = device ] && break
  sleep 2
done
[ "${state:-}" = device ] || die "the TV did not authorise ADB at $target (state: ${state:-none})"
tvsh() { "$ADB" -s "$target" shell "$@"; }

tvsh pm path "$FULLY" >/dev/null 2>&1 || die "Fully Kiosk Browser is not installed on the TV; install it from the Play Store first"
tvsh pm enable --user 0 "$FULLY" >/dev/null 2>&1 || true
# Fully refuses file:// pages without read access to shared storage; the media permissions are what it checks.
for perm in READ_MEDIA_IMAGES READ_MEDIA_VIDEO READ_MEDIA_AUDIO READ_EXTERNAL_STORAGE; do
  tvsh pm grant "$FULLY" "android.permission.$perm" >/dev/null 2>&1 || true
done

page=$(mktemp)
trap 'rm -f "$page"' EXIT
template=$(cat "$HERE/start.html")
placeholder='{{SERVERS}}'
[ "$(grep -c "$placeholder" "$HERE/start.html")" = 1 ] || die "start.html must hold exactly one $placeholder"
printf '%s\n' "${template/"$placeholder"/[$servers]}" >"$page"
tvsh mkdir -p "$FILES"
"$ADB" -s "$target" push "$page" "$FILES/start.html" >/dev/null 2>&1
echo "Start page installed at $PAGE_URL"

if [ -n "$password" ]; then
  host=${target%:*}
  api() { curl -fsS --get "http://$host:2323/" --data-urlencode type=json --data-urlencode "password=$password" "$@" >/dev/null; }
  api --data-urlencode cmd=deviceInfo || die "Fully Remote Admin did not answer on $host:2323 (enable it, then restart Fully)"
  api --data-urlencode cmd=setStringSetting --data-urlencode key=startURL --data-urlencode "value=$PAGE_URL"
  api --data-urlencode cmd=setStringSetting --data-urlencode key=errorURL --data-urlencode "value=$PAGE_URL"
  for kv in softKeyboard=true launchOnBoot=true keepScreenOn=true reloadOnScreenOn=true autoplayVideos=true showMenuHint=false; do
    api --data-urlencode cmd=setBooleanSetting --data-urlencode "key=${kv%=*}" --data-urlencode "value=${kv#*=}"
  done
  api --data-urlencode cmd=loadStartURL
  echo "Fully configured over Remote Admin."
else
  tvsh am start -a android.intent.action.VIEW -n "$FULLY/.MainActivity" -d "$PAGE_URL" >/dev/null
  cat <<EOF
Fully is showing the start page now. Set these once in Fully (Menu key or long Back → Settings, use the search box):
  Start URL ..................... $PAGE_URL
  Enable Text Input ............. on   (without it the remote's keys never reach the page)
  Launch on Boot ................ on
  Keep Screen On ................ on
  Auto Reload on Screen On ...... on
  Autoplay Videos ............... on
  Show Menu Hint on Start ....... off
EOF
fi
