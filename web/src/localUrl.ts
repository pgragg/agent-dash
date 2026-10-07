/**
 * The files behind the "Open agent-dash at your own URL" help page (`#/help/local-url`).
 * Kept free of React so the tests can check what the page tells people to run.
 *
 * The chain: /etc/hosts sends the name to 127.0.0.1, pf sends ports 80 and 443 to Caddy on
 * 7080 and 7443, and Caddy ends TLS with its own local CA and proxies to agent-dash. The
 * pf redirect lets Caddy run as the user, so only one step needs sudo.
 */

export const CADDY_HTTP = 7080;
export const CADDY_HTTPS = 7443;

/** A host name that is safe to paste into a shell script. Null when it is not one. */
export function cleanHost(input: string): string | null {
  const h = input.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  return /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/.test(h) ? h : null;
}

export function cleanPort(input: string): number | null {
  const n = Number(input.trim());
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

/** Step 1, no sudo: add the site to Homebrew's Caddyfile and start Caddy as a brew service. */
export function caddyCommands(host: string, port: number): string {
  return `brew install caddy
cat >> "$(brew --prefix)/etc/Caddyfile" <<'EOF'
{
	auto_https disable_redirects
	skip_install_trust
	http_port ${CADDY_HTTP}
	https_port ${CADDY_HTTPS}
}

http://${host}:${CADDY_HTTP} {
	bind 127.0.0.1
	redir https://${host}{uri} permanent
}

https://${host}:${CADDY_HTTPS} {
	bind 127.0.0.1
	tls internal
	reverse_proxy 127.0.0.1:${port}
}
EOF
brew services restart caddy`;
}

/** Step 2, with sudo: the host name, the port redirect (also at each boot), and trust in Caddy's CA. */
export function rootScript(host: string): string {
  return `#!/bin/sh
set -eu
HOST=${host}
PREFIX=$([ -d /opt/homebrew ] && echo /opt/homebrew || echo /usr/local)
ANCHOR=/etc/pf.anchors/local-url
PLIST=/Library/LaunchDaemons/local.agent-dash.pf.plist

# 1. The name goes to this Mac.
grep -q "[[:space:]]$HOST\\$" /etc/hosts || printf '127.0.0.1\\t%s\\n' "$HOST" >> /etc/hosts

# 2. Ports 80 and 443 on 127.0.0.1 go to Caddy. Apple's "com.apple/*" anchor runs
#    this file, so /etc/pf.conf stays as it is.
cat > "$ANCHOR" <<'PF'
rdr pass on lo0 inet proto tcp from any to 127.0.0.1 port 80 -> 127.0.0.1 port ${CADDY_HTTP}
rdr pass on lo0 inet proto tcp from any to 127.0.0.1 port 443 -> 127.0.0.1 port ${CADDY_HTTPS}
PF

# 3. pf forgets its rules at reboot, so a LaunchDaemon loads them at each boot.
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>local.agent-dash.pf</string>
  <key>ProgramArguments</key><array>
    <string>/bin/sh</string><string>-c</string>
    <string>/sbin/pfctl -a com.apple/250.local-url -f $ANCHOR; /sbin/pfctl -e 2>/dev/null; exit 0</string>
  </array>
  <key>RunAtLoad</key><true/>
</dict></plist>
PL
chown root:wheel "$PLIST"; chmod 644 "$PLIST"
launchctl bootout system "$PLIST" 2>/dev/null || true
launchctl bootstrap system "$PLIST"

# 4. Trust Caddy's local CA, so the browser accepts the certificate.
ROOT="$PREFIX/var/lib/caddy/pki/authorities/local/root.crt"
[ -f "$ROOT" ] || { echo "No Caddy CA at $ROOT. Do step 1 first." >&2; exit 1; }
security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "$ROOT"

dscacheutil -flushcache; killall -HUP mDNSResponder 2>/dev/null || true
echo "Done: open https://$HOST"
`;
}

/** Undo both steps. */
export function undoCommands(host: string): string {
  return `sudo launchctl bootout system /Library/LaunchDaemons/local.agent-dash.pf.plist
sudo rm /Library/LaunchDaemons/local.agent-dash.pf.plist /etc/pf.anchors/local-url
sudo pfctl -a com.apple/250.local-url -F all
sudo sed -i '' '/[[:space:]]${host.replace(/\./g, "\\.")}$/d' /etc/hosts
sudo security delete-certificate -Z "$(openssl x509 -noout -fingerprint -sha1 -in "$(brew --prefix)/var/lib/caddy/pki/authorities/local/root.crt" | cut -d= -f2 | tr -d :)" /Library/Keychains/System.keychain
brew services stop caddy   # and remove the two ${host} blocks from $(brew --prefix)/etc/Caddyfile`;
}
