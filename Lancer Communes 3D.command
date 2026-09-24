#!/bin/zsh
cd -- "${0:A:h}"
communes_url="http://127.0.0.1:3010/"
if /usr/bin/curl --fail --silent --max-time 1 "$communes_url" >/dev/null 2>&1; then
  open "$communes_url"
  exit 0
fi
if [[ ! -d node_modules ]]; then
  npm ci || exit 1
fi
npm run dev &
communes_pid=$!
trap 'kill "$communes_pid" 2>/dev/null' EXIT INT TERM
for communes_attempt in {1..80}; do
  if /usr/bin/curl --fail --silent --max-time 1 "$communes_url" >/dev/null 2>&1; then
    open "$communes_url"
    wait "$communes_pid"
    exit $?
  fi
  if ! kill -0 "$communes_pid" 2>/dev/null; then
    wait "$communes_pid"
    exit $?
  fi
  sleep 0.25
done
print "Le serveur tarde à démarrer. Consultez les messages ci-dessus."
wait "$communes_pid"
