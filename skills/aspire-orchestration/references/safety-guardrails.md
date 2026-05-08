# Safety Guardrails — Aspire Agent Rules

> **Purpose**: Detailed explanation of why each guardrail exists, what goes wrong when violated, and how to recover.

## Why These Rules Exist

Issue [#15801](https://github.com/microsoft/aspire/issues/15801) documented 5 specific failures when AI agents work in Aspire projects without guidance. Every rule below directly prevents one or more of these failures.

---

## Rule 1: ALWAYS `aspire start` — NEVER `dotnet run`

### Why `dotnet run` Is Dangerous for AppHosts

The AppHost project is an **orchestrator**, not a regular .NET app. Running it with `dotnet run`:

- **Bypasses the Aspire CLI orchestration layer** — resources don't get managed lifecycle
- **No dashboard** — the Aspire developer dashboard won't launch
- **No backchannel** — `aspire wait`, `aspire logs`, `aspire describe` won't work
- **No resource management** — can't rebuild/restart individual resources
- **Port conflicts** — resources start without coordinated port allocation
- **No cleanup** — orphaned processes when the host exits

### Correct Pattern

```bash
# ✅ Start the Aspire app
aspire start

# ✅ Verify it's running
aspire ps
```

### `aspire run` vs `aspire start`

| Command | Mode | Dashboard | Use Case |
|---------|------|-----------|----------|
| `aspire run` | Foreground (interactive) | Yes, in terminal | Human developer at terminal |
| `aspire start` | Background (detached) | No terminal output | **AI agents — always prefer this** |
| `aspire run --detach` | Background (same as start) | Yes, separate window | Alternative to `aspire start` |

For AI agents, **always use `aspire start`** — it runs in the background and returns control to the agent.

### Recovery If `dotnet run` Was Used

```bash
# Kill the dotnet process manually (find PID first)
# Then start correctly:
aspire start
```

---

## Rule 2: ALWAYS `aspire wait` — NEVER `curl` Polling

### Why `curl` Polling Is Wrong

Aspire tracks resource readiness internally through health checks, dependency graphs, and startup ordering. Manual HTTP polling:

- **Doesn't know the correct port** — Aspire assigns ports dynamically
- **Doesn't respect dependency ordering** — a resource may respond to HTTP before its dependencies are ready
- **Creates false negatives** — health endpoint may not exist or may return 503 during startup
- **Wastes time** — retry loops with arbitrary delays vs. event-driven readiness

### Correct Pattern

```bash
# ✅ Wait for a specific resource
aspire wait apiservice

# ✅ Wait with extended timeout for slow resources
aspire wait postgres --timeout 120

# ✅ Wait then interact
aspire wait apiservice && curl $(aspire describe apiservice --format Json | jq -r '.endpoints[0].url')
```

### Machine-Readable Output

Always use `--format Json` when parsing output programmatically:

```bash
# ✅ Get resource endpoints as JSON
aspire describe --format Json

# ❌ Never scrape text output
aspire describe | grep "http"  # fragile, format may change
```

---

## Rule 3: ALWAYS `aspire resource restart` — NEVER `dotnet build`

### Why `dotnet build` Causes File-Lock Errors

When Aspire is running, it holds file locks on:

- Output assemblies (`.dll`, `.pdb`) of managed resources
- Build intermediates in `obj/` directories
- NuGet package caches being read by running processes

Running `dotnet build` while Aspire holds these locks produces:

```
error MSB3491: Could not write to output file 'bin/Debug/net10.0/MyService.dll'
error CS2012: Cannot open 'obj/Debug/net10.0/MyService.dll' for writing
```

The agent then concludes the project is "un-buildable" — a false conclusion.

### Correct Pattern

```bash
# ✅ Rebuild a specific resource (Aspire manages the build)
aspire resource apiservice restart

# ✅ If AppHost code changed, full restart
aspire stop
# ... make changes ...
aspire start
```

### What Changed Determines the Action

| What Changed | Action | Command |
|--------------|--------|---------|
| AppHost project (Program.cs, .csproj) | Full restart | `aspire stop` → edit → `aspire start` |
| .NET service project (.cs files) | Rebuild resource | `aspire resource <name> restart` |
| JavaScript/Python/Go files | No action | File watchers handle it automatically |
| Configuration (appsettings.json) | Check first | `aspire describe` then decide |

---

## Rule 4: ALWAYS `aspire stop` — NEVER Leave Processes Running

### Why Cleanup Matters

Aspire orchestrates multiple processes (your services, databases, message brokers, etc.). Leaving them running causes:

- **Port conflicts** — next `aspire start` fails because ports are occupied
- **File locks** — can't build or modify service code
- **Resource consumption** — databases, Redis, etc. consuming memory
- **Stale state** — old code running while you've made changes
- **Orphaned containers** — Docker containers left running

### Correct Pattern

```bash
# ✅ Always stop when done
aspire stop

# ✅ Verify everything stopped
aspire ps  # should show no running resources
```

### Recovery from Orphaned Processes

```bash
# Check if anything is still running
aspire ps

# If aspire ps shows nothing but ports are blocked:
# The previous instance may have crashed. Start fresh:
aspire start  # will clean up orphaned state
```

---

## Rule 5: ALWAYS `--format Json` for Machine-Readable Output

### Why JSON Output Matters for Agents

Text output is formatted for humans and may change between versions. JSON output is:

- **Stable** — structured contract unlikely to break
- **Parseable** — `jq`, Python, or any JSON parser works
- **Complete** — includes fields not shown in text output

### Examples

```bash
# ✅ Machine-readable resource list
aspire ps --format Json

# ✅ Get specific resource details
aspire describe apiservice --format Json

# ✅ Parse with jq
aspire describe --format Json | jq '.resources[] | select(.state == "Running")'
```

### ⚠️ Known JSON Output Issues

| Issue | Workaround |
|-------|-----------|
| `aspire start --format json` may emit human-readable text before JSON ([#15843](https://github.com/microsoft/aspire/issues/15843)) | Strip non-JSON lines before parsing |
| `aspire stop` does NOT support `--format json` yet | Use exit code for success/failure |
| `aspire ps --format Json` returns `name` and `displayName` fields | Use `displayName` for `aspire wait` — the `name` field may be rejected ([#15842](https://github.com/microsoft/aspire/issues/15842)) |

### Hidden Resources and `--include-hidden`

Starting in Aspire 13.3, `aspire ps`, `aspire describe`, and other CLI commands **filter out
resources marked as hidden in the AppHost** (proxies, helper containers, migration jobs, etc.).
This filtering is correct for normal workflows — agents and humans see only the resources they
care about, not the implementation scaffolding.

Use `--include-hidden` when:

| Situation | Why |
|-----------|-----|
| Debugging a proxy or sidecar | Proxies are hidden by default; you need their state to diagnose connectivity |
| Investigating helper containers | Helper containers (e.g. wait-for-it shims, init containers) are hidden |
| Tracking down migration jobs | Migration / seed jobs are typically hidden once they finish |
| Expected resources are missing from `aspire ps` | The resource may exist but be marked hidden — confirm with `--include-hidden` before assuming the AppHost is wrong |
| Parsing for completeness in agent automation | A full-graph view requires explicit opt-in |

```bash
# ✅ Normal flow — filtered (correct for most tasks)
aspire ps --format Json

# ✅ Debugging / completeness — include hidden resources
aspire ps --include-hidden --format Json
aspire describe --include-hidden --format Json
```

If a user reports "I can't see my proxy / migration / helper container," reach for
`--include-hidden` before assuming the AppHost is misconfigured.

---

## Rule 6: ALWAYS `--non-interactive` for Agent Commands

### Why It Matters

AI agents run in non-interactive terminals. Some Aspire CLI commands may prompt for confirmation or input. Always pass `--non-interactive` to prevent hangs:

```bash
# ✅ Agent-safe commands
aspire start --non-interactive
aspire deploy --non-interactive
aspire agent init --non-interactive
```

> ⚠️ **Known issue**: `aspire agent init --non-interactive` is broken in some versions ([#16264](https://github.com/microsoft/aspire/issues/16264), [#15071](https://github.com/microsoft/aspire/issues/15071)). If it fails, instruct the user to run it from a standard terminal.

---

## Recovery Patterns Summary

| Mistake Made | Recovery Steps |
|-------------|---------------|
| Used `dotnet run` on AppHost | Kill the process, run `aspire start` |
| Used `dotnet build` and got file locks | `aspire stop`, wait 2s, then `dotnet build` or `aspire start` |
| Used `curl` polling and got false results | `aspire wait <resource>`, then use endpoints from `aspire describe` |
| Left Aspire running, now ports conflict | `aspire stop`, then `aspire start` |
| Resource won't start after code change | Fix code, `aspire resource <name> restart` |
| Nothing works, environment broken | `aspire doctor` to diagnose, then follow recommendations |
