#!/bin/bash
set -e
LABEL="com.luxuryhunter.app"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
launchctl bootout "gui/$UID/$LABEL" >/dev/null 2>&1 || true
rm -f "$PLIST"
echo "OK: modo background desinstalado."
