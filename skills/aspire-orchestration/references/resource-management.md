# Resource Management

Use this when the task is scoped to one resource or depends on a specific resource becoming healthy.

## Wait For One Resource Before Touching It

```bash
aspire wait <resource>
aspire wait <resource> --status up --timeout 60
```

- Use `aspire wait` before a dependent action when readiness is the blocker.
- Add `--status` and `--timeout` for explicit readiness conditions.
- Treat readiness as resource-scoped — a missing ready signal is not a reason to restart the whole AppHost.
- Use `displayName` from `aspire ps --format Json`, not `name` ([#15842](https://github.com/microsoft/aspire/issues/15842)).

## Fix Or Operate On One Resource Without Bouncing The Whole App

```bash
aspire resource <resource> start
aspire resource <resource> stop
aspire resource <resource> restart
aspire resource <resource> <command>
```

- Prefer resource-scoped commands when the task doesn't require an AppHost-wide restart.
- If one resource is wedged, use `aspire resource <resource> restart` before escalating to full restart.
- Use `aspire resource <resource> <command>` when the AppHost exposes resource-specific dashboard or operational commands.

## What Changed Determines the Action

| What Changed | Action | Command |
|--------------|--------|---------|
| AppHost project (Program.cs, .csproj) | Full restart | `aspire stop` → edit → `aspire start` |
| .NET service project (.cs files) | Rebuild resource | `aspire resource <name> restart` |
| JavaScript/Python/Go files | No action | File watchers handle it automatically |
| Configuration (appsettings.json) | Check first | `aspire describe` then decide |
| TypeScript AppHost deps | Restore | `aspire restore` |
