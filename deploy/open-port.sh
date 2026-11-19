#!/usr/bin/env bash
# Open inbound TCP ports on a VM whose image filters traffic itself.
#
# Oracle Cloud's Ubuntu images ship an iptables ruleset that accepts SSH and
# drops everything else, so a service that is listening and healthy still answers
# nowhere. The cloud console's security list is the other half of the same
# problem: both have to allow the port, and only one of them lives inside the
# machine.
#
#   sudo bash deploy/open-port.sh 3000 80 443
#
# Rules go at the top of INPUT (order does not matter for an ACCEPT) and are
# saved, so they survive a reboot.

set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "Usage: sudo bash deploy/open-port.sh <port> [port ...]"
  exit 1
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run with sudo: sudo bash deploy/open-port.sh $*"
  exit 1
fi

if ! command -v iptables >/dev/null 2>&1; then
  echo "iptables is not installed on this host; nothing to open here."
  exit 1
fi

for port in "$@"; do
  case "${port}" in
    ''|*[!0-9]*)
      echo "Not a port: ${port}" >&2
      exit 1
      ;;
  esac

  if iptables -C INPUT -p tcp --dport "${port}" -j ACCEPT 2>/dev/null; then
    echo "port ${port} is already open"
  else
    iptables -I INPUT 1 -p tcp --dport "${port}" -j ACCEPT
    echo "opened port ${port}"
  fi
done

# Save, or the rules last only until the next reboot. Oracle's images use
# netfilter-persistent; plain Debian/Ubuntu images read /etc/iptables/rules.v4.
if command -v netfilter-persistent >/dev/null 2>&1; then
  netfilter-persistent save >/dev/null
  echo "saved with netfilter-persistent"
else
  mkdir -p /etc/iptables
  iptables-save > /etc/iptables/rules.v4
  echo "saved to /etc/iptables/rules.v4 (install iptables-persistent to load it at boot)"
fi
