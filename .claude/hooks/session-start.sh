#!/bin/bash
# SessionStart hook for Claude Code on the web.
#
# Gives a cloud session the fleet coordination wallet so the room commands in
# AGENTS.md (`run402 --wallet platform-deploy rooms join …`) work unchanged.
#
# The key arrives as RUN402_FLEET_WALLET_KEY from the cloud environment's
# settings. It is a dedicated developer member of the fleet org, NOT a human's
# key and NOT a deployment wallet: keep it unfunded. On a human machine the
# `platform-deploy` profile is that human's own; this hook never runs there.
set -uo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

ROOM_ORG="57035b1e-ec41-4ce6-a7a5-a5b2560efdd7"
ROOM_KEY="run402-dev"
PROFILE="platform-deploy"

if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  # Node's built-in fetch ignores HTTPS_PROXY unless told; the CLI uses it.
  echo 'export NODE_USE_ENV_PROXY=1' >> "$CLAUDE_ENV_FILE"
  echo "export RUN402_ROOM=${ROOM_ORG}/${ROOM_KEY}" >> "$CLAUDE_ENV_FILE"
fi
export NODE_USE_ENV_PROXY=1

if [ -z "${RUN402_FLEET_WALLET_KEY:-}" ]; then
  echo "fleet room: RUN402_FLEET_WALLET_KEY is not set in this environment; no coordination wallet imported, room commands will fail WALLET_NOT_FOUND."
  exit 0
fi

if ! command -v run402 >/dev/null 2>&1; then
  npm install -g run402 >/dev/null 2>&1 || { echo "fleet room: npm install -g run402 failed"; exit 0; }
fi

if run402 wallets list 2>/dev/null | grep -q "\"local_label\": \"${PROFILE}\""; then
  echo "fleet room: wallet profile '${PROFILE}' already present"
else
  # Label sync off: the server label belongs to the human's platform-deploy wallet.
  if printf '%s' "$RUN402_FLEET_WALLET_KEY" | RUN402_WALLET_LABEL_SYNC=0 run402 wallets import "$PROFILE" --key - >/dev/null 2>&1; then
    echo "fleet room: imported the fleet coordination wallet as profile '${PROFILE}'"
  else
    echo "fleet room: wallet import failed; room commands will fail WALLET_NOT_FOUND"
    exit 0
  fi
fi

ADDR="$(run402 wallets list 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const w=JSON.parse(s).find(x=>x.local_label===process.argv[1]);console.log(w?w.address:"?")}catch{console.log("?")}})' "$PROFILE")"
echo "fleet room: ready. Join with: run402 --wallet ${PROFILE} rooms join --name <pick-your-own> --task \"<what you're doing>\" (wallet ${ADDR}, developer member of org ${ROOM_ORG}; coordination only, keep unfunded)"
exit 0
