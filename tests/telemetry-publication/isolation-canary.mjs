import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runContainer, verifierImage } from "../../scripts/telemetry-workflow.mjs";

assert.equal(process.platform, "linux", "The isolation canary requires the Linux CI Docker runner.");
const directory = mkdtempSync(join(tmpdir(), "telemetry-isolation-canary-"));
const workspace = join(directory, "src");
const cache = join(directory, "cache");
const host = join(directory, "host");
for (const path of [join(workspace, ".dotnet"), join(cache, "home"), host]) mkdirSync(path, { recursive: true });
const files = Object.fromEntries(["GITHUB_OUTPUT", "GITHUB_ENV", "GITHUB_PATH", "GITHUB_STEP_SUMMARY", "HOME"]
  .map(name => [name, join(host, name)]));
for (const path of Object.values(files)) writeFileSync(path, "host canary must remain unchanged\n");
writeFileSync(join(workspace, "host-paths"), Object.values(files).join("\n") + "\n");
writeFileSync(join(workspace, ".dotnet", "dotnet"), `#!/bin/bash
set -euo pipefail
test "$1" = test
test "$(id -u)" -ne 0
test "$HOME" = /cache/home
test -z "\${GITHUB_TOKEN-}\${GH_TOKEN-}\${ACTIONS_RUNTIME_TOKEN-}\${ACTIONS_ID_TOKEN_REQUEST_TOKEN-}\${SSH_AUTH_SOCK-}"
test -z "\${GITHUB_OUTPUT-}\${GITHUB_ENV-}\${GITHUB_PATH-}\${GITHUB_STEP_SUMMARY-}\${RUNNER_TEMP-}"
test ! -S /var/run/docker.sock
test "$(ls /sys/class/net)" = lo
awk '/^CapEff:/ { if ($2 != "0000000000000000") exit 1; caps=1 }
     /^NoNewPrivs:/ { if ($2 != "1") exit 1; privileges=1 }
     END { if (!caps || !privileges) exit 1 }' /proc/self/status
awk '$2 == "/" && $4 ~ /(^|,)ro(,|$)/ { readonly_root=1 }
     END { if (!readonly_root) exit 1 }' /proc/mounts
while IFS= read -r path; do
  test ! -e "$path"
  if (printf "hostile overwrite" > "$path") 2>/dev/null; then
    echo "Host canary was writable: $path" >&2
    exit 1
  fi
done < /src/host-paths
printf '#!/bin/sh\\nexit 0\\n' > /tmp/executable-canary
chmod +x /tmp/executable-canary
/tmp/executable-canary
printf '::error::telemetry-isolation-hostile-canary\\n::set-output name=forged::yes\\n'
printf 'isolation checked\\n' > /cache/canary-passed
`, { mode: 0o755 });
const values = {
  ...files, GITHUB_TOKEN: "dummy-host-token", GH_TOKEN: "dummy-host-token",
  ACTIONS_RUNTIME_TOKEN: "dummy-actions-token", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "dummy-oidc-token",
  SSH_AUTH_SOCK: join(host, "ssh.sock"), GITHUB_RUN_ID: process.env.GITHUB_RUN_ID || String(Date.now()),
  GITHUB_RUN_ATTEMPT: process.env.GITHUB_RUN_ATTEMPT || "1"
};
const previous = Object.fromEntries(Object.keys(values).map(name => [name, process.env[name]]));
try {
  execFileSync("docker", ["pull", "--quiet", "--platform=linux/amd64", verifierImage], { stdio: "inherit" });
  Object.assign(process.env, values);
  runContainer({
    workspace, cache, name: `aspire-telemetry-${values.GITHUB_RUN_ID}-${values.GITHUB_RUN_ATTEMPT}`,
    uid: process.getuid(), gid: process.getgid(), offline: true, base: "a".repeat(40)
  });
  assert.equal(readFileSync(join(cache, "canary-passed"), "utf8"), "isolation checked\n");
  for (const path of Object.values(files)) assert.equal(readFileSync(path, "utf8"), "host canary must remain unchanged\n");
  console.log("Telemetry container isolation canary passed.");
} finally {
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(directory, { recursive: true, force: true });
}
