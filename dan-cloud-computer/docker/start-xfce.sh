#!/bin/bash
# Wait for the X display to come up, then launch the XFCE session.
set -e
export DISPLAY=:1
export HOME=/root

for i in $(seq 1 60); do
    if xdpyinfo -display :1 >/dev/null 2>&1; then
        break
    fi
    sleep 0.5
done

exec startxfce4
