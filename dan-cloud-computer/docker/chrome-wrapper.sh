#!/bin/bash
# Launch Google Chrome with flags required to run inside a container.
# The profile lives on the persistent volume so sessions/cookies survive
# stop/start of the computer.
exec /opt/google/chrome/google-chrome \
    --no-sandbox \
    --disable-dev-shm-usage \
    --no-first-run \
    --no-default-browser-check \
    --password-store=basic \
    --user-data-dir=/root/persist/chrome \
    "$@"
