#!/bin/bash
LABEL="com.luxuryhunter.app"
if launchctl print "gui/$UID/$LABEL" >/tmp/luxury-hunter-launchd-status.txt 2>/dev/null; then
  echo "Luxury Hunter background: INSTALADO"
  grep -E 'state =|pid =|last exit code =' /tmp/luxury-hunter-launchd-status.txt | head -10 || true
else
  echo "Luxury Hunter background: NO INSTALADO / NO ACTIVO"
  exit 1
fi
