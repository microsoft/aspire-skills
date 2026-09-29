# Resource terminals and built-in REPLs

## Give the resource's process a PTY

Use this for an existing interactive CLI/TUI, not to open an extra shell inside
a service. Keep the resource's existing command, arguments, dependencies and
environment. For example, given an existing `worker` resource builder:

```csharp
#pragma warning disable ASPIRETERMINAL001
worker.WithTerminal(options =>
{
    options.Columns = 132;
    options.Rows = 50;
});
#pragma warning restore ASPIRETERMINAL001
```

This applies to executable, project and container execution paths. The generic
constraint accepts `IResource`, but that does not give arbitrary non-compute
resources a process. Don't add a second `WithTerminal` call: duplicates fail.

`TerminalOptions` has only `Columns`, `Rows`, `ShowTerminalHost`; dimensions must
be positive. There is no `Shell`. To select a shell, configure the resource's
executable/entry point using its ordinary API, after resolving the OS and path.
Defaults are 120x30 in `v13.5.0`, 132x50 in the inspected 13.6 code. Set dimensions
explicitly for stable fixtures rather than depending on defaults.

TypeScript is deliberately smaller:

```ts
await worker.withTerminal();
```

No dimensions DTO is exported for `withTerminal()` in this baseline. Do not add
`{ columns, rows }`, a shell option, or C#-style warning suppressions to TS.
Read generated declarations if verifying an installed integration; never edit them.

## Replicas and lifecycle

Every replica receives its own terminal and hidden helper process. Calling
`WithReplicas` before or after `WithTerminal` is supported. Select the intended
replica when interacting; don't broadcast input or assume replica zero.

The resource lifecycle owns the producer. Detaching a viewer, disconnecting CLI
automation or disposing a resource-owned automation handle does not stop the
workload. Use resource lifecycle commands to stop/restart it.

PTY execution forces process execution and cannot be combined with the current
IDE-launched debugger execution path. Explain this tradeoff instead of promising
simultaneous debugger launch and terminal hosting.

Hidden terminal helpers are run-mode infrastructure and excluded from publishing.
`ShowTerminalHost = true` makes helpers visible and, in the inspected 13.6 code,
opts them into diagnostic telemetry. Use it for investigation, not by default.

## Dashboard behavior

For a selected running terminal resource, the dashboard defaults to Terminal;
non-running resources default to Console. Ordinary refresh preserves the user's
chosen view. Console logging remains available.

Resource and dock terminals support separate browser windows without creating
another workload, shared viewers, reconnect/state replay, scrollback/reflow,
selection/copy/paste, font controls and grid/fit sizing. Primary-viewer ownership
controls resizing; view-local read-only UI is not a global terminal lock.
The renderer supports OSC 8 hyperlinks and Sixel/Kitty graphics, with WebGPU/WebGL2
rendering. These display capabilities do not imply screenshot/video tape outputs.

## Prefer built-in client commands

The inspected 13.6 integrations expose opt-in `WithRepl()` / `withRepl()`:

| Integration | Client | Package |
|-------------|--------|---------|
| PostgreSQL | `psql` | `Aspire.Hosting.PostgreSQL` |
| Redis | `redis-cli` | `Aspire.Hosting.Redis` |
| Valkey | `valkey-cli` | `Aspire.Hosting.Valkey` |
| MongoDB | `mongosh` | `Aspire.Hosting.MongoDB` |
| MySQL | `mysql` | `Aspire.Hosting.MySql` |
| SQL Server | `sqlcmd` | `Aspire.Hosting.SqlServer` |

For example, opt in on the existing typed PostgreSQL **server** resource:

```csharp
postgres.WithRepl();
```

```ts
await postgres.withRepl();
```

These methods add a run-mode resource command opening an authenticated docked
client. They do not require `WithTerminal` on the database server, nor experimental
warning suppression just for the `WithRepl` call. Verify the particular integration
package supports it; it is not a universal method on every resource.

The built-in helper resolves Docker/Podman and the current container ID at
invocation. The command is disabled until the resource is Running and has an ID.
Prefer it over custom exec with hard-coded container names (which breaks replicas,
restarts and isolated worktrees). `ContainerReplCommand` is internal, not an API
to copy into generated code.

Passwords are forwarded through environment variables rather than argv values.
This is still privileged authenticated access for trusted dashboard users;
the SQL Server client uses `sa`. Quit the client before closing the tab:
terminating the local container-exec process need not stop the remote client.

## Source evidence

- [Resource extensions and TS export](https://github.com/microsoft/aspire/blob/34db30a7d3733229da64a403dfc4e4e4d7a1a43b/src/Aspire.Hosting/TerminalResourceBuilderExtensions.cs)
- [REPL feature and integration changes](https://github.com/microsoft/aspire/pull/20231)
- [13.6 REPL backport](https://github.com/microsoft/aspire/pull/20419)

These links describe the researched source, not every preview package.
