#!/bin/sh
# First-boot bootstrap: create client.db, enable the Hydrus Client API and
# register HYDRUS_API_KEY with every permission, then hand over to the image's
# entrypoint. An existing client.db is never modified. Later boots skip
# straight to the entrypoint (marker file).
set -eu

DB_DIR=/opt/hydrus/db

if [ ! -f "$DB_DIR/.initialized" ]; then
  # A fresh bind mount is owned by root; the client runs as the hydrus user.
  chown hydrus:hydrus "$DB_DIR"

  if [ -f "$DB_DIR/client.db" ]; then
    # Injecting would replace this library's Client API service and wipe its access keys.
    echo "Existing client.db found: Client API left untouched, enable it from the GUI (see README)."
  else
    if ! printf '%s' "${HYDRUS_API_KEY:-}" | grep -Eq '^[0-9a-f]{64}$'; then
      echo "ERROR: HYDRUS_API_KEY must be 64 lowercase hex chars (openssl rand -hex 32)." >&2
      exit 1
    fi

    # The Client API settings live in client.db, so let Hydrus create it
    # headless and stop it once the GUI is up.
    echo "Initializing hydrus client database."
    INIT_LOG=$(mktemp)
    su hydrus -s /bin/sh -c "/usr/bin/env QT_QPA_PLATFORM=offscreen python3 /opt/hydrus/hydrus_client.py -d $DB_DIR/" >"$INIT_LOG" 2>&1 &
    HYDRUS_PID=$!
    ELAPSED=0
    while [ $ELAPSED -lt 120 ]; do
      if grep -q "To dismiss popup messages" "$INIT_LOG" 2>/dev/null; then
        echo "Hydrus initialization complete, shutting down..."
        break
      fi
      sleep 1
      ELAPSED=$((ELAPSED + 1))
    done
    kill -INT $HYDRUS_PID 2>/dev/null || true
    wait $HYDRUS_PID 2>/dev/null || true
    rm -f "$INIT_LOG"

    # Hydrus' own serialisation of the Client API service: port 45869,
    # non-local connections allowed (other containers), CORS on, plain HTTP.
    JSON='[21, 2, ['
    JSON="$JSON"'[[0, "port"], [0, 45869]], '
    JSON="$JSON"'[[0, "upnp_port"], [0, null]], '
    JSON="$JSON"'[[0, "allow_non_local_connections"], [0, true]], '
    JSON="$JSON"'[[0, "support_cors"], [0, true]], '
    JSON="$JSON"'[[0, "log_requests"], [0, false]], '
    JSON="$JSON"'[[0, "use_normie_eris"], [0, true]], '
    JSON="$JSON"'[[0, "bandwidth_tracker"], [2, [39, 1, [[], [], [], [], [], [], [], [], [], []]]]], '
    JSON="$JSON"'[[0, "bandwidth_rules"], [2, [38, 1, []]]], '
    JSON="$JSON"'[[0, "external_scheme_override"], [0, null]], '
    JSON="$JSON"'[[0, "external_host_override"], [0, null]], '
    JSON="$JSON"'[[0, "external_port_override"], [0, null]], '
    JSON="$JSON"'[[0, "use_https"], [0, false]]]]'
    SERVICE_CONFIG_HEX=$(printf '%s' "$JSON" | xxd -p | tr -d '\n')
    # One access key; "true" = permits everything.
    JSON="[[76, \"new api permissions\", 2, [\"$HYDRUS_API_KEY\", true, [], [44, 1, []]]]]"
    API_KEY_CONFIG_HEX=$(printf '%s' "$JSON" | xxd -p | tr -d '\n')

    apk add --no-cache sqlite
    sqlite3 "$DB_DIR/client.db" \
      "UPDATE services SET dictionary_string = X'$SERVICE_CONFIG_HEX' WHERE service_type = 18;"
    sqlite3 "$DB_DIR/client.db" \
      "UPDATE json_dumps SET dump = X'$API_KEY_CONFIG_HEX' WHERE dump_type = 75;"
  fi

  touch "$DB_DIR/.initialized"
  echo "Done, bootstrapping to main entrypoint."
fi

exec /bin/sh /opt/hydrus/static/build_files/docker/client/entrypoint.sh
