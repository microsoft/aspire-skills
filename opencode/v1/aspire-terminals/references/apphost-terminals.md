# AppHost-owned terminals: dock, prompt or headless

Requires a build containing the 13.6 APIs. Public terminal types live in
`Aspire.Hosting.ApplicationModel`. `TerminalService` is already in Aspire DI:
use `context.Services.GetRequiredService<TerminalService>()` in commands or
`app.Services` after `builder.Build()`. Do not instantiate it directly.

`TerminalLaunchOptions` requires `Title` and `Executable`. `Arguments` is a list;
`EnvironmentVariables` is a get-only dictionary of overrides to the inherited
AppHost environment. WorkingDirectory defaults to the AppHost directory.
Columns/Rows default to 80x24 and must be positive. Placement defaults to Dock;
Dialog and None are valid, ResourceView is rejected. Options are captured when
created; changing the original options later does not modify the terminal.

The command recipes below assume an existing `resource` builder and `builder`.
Imports:

```csharp
using Aspire.Hosting;
using Aspire.Hosting.ApplicationModel;
using Microsoft.Extensions.DependencyInjection;
```

Register each command only inside `if (builder.ExecutionContext.IsRunMode)`.
Replace the sample executable/script with a verified workspace tool. Never
construct shell commands by concatenating user input. Use argument lists and
environment overrides; avoid secrets in argv, output or committed examples.

## Persistent dock: command returns, tool remains open

This example opens a local .NET interactive tool selected by the application.
`toolPath` is a verified absolute path to that tool's DLL, not a container path.

```csharp
#pragma warning disable ASPIRETERMINAL001
if (builder.ExecutionContext.IsRunMode)
{
    resource.WithCommand("open-tool", "Open tool", context =>
    {
        var terminals = context.Services.GetRequiredService<TerminalService>();
        var terminal = terminals.CreateTerminal(new TerminalLaunchOptions
        {
            Title = "Interactive tool",
            Executable = "dotnet",
            Arguments = { toolPath },
            Placement = TerminalPlacement.Dock
        });

        terminal.Start();
        terminal.Show();
        return Task.FromResult(CommandResults.Success());
    });
}
#pragma warning restore ASPIRETERMINAL001
```

Deliberately **no `await using`**: disposing when the command returns would kill
the session. Success means "opened", not "tool completed successfully". `Start()`
is idempotent/nonblocking, not a readiness check. A launch/exit failure is visible
in the terminal; add bounded output checks if opening requires a ready handshake.

The dock supports activation, tab switching/closing, resizing, keyboard access and
desktop/mobile toggles, and persists across page navigation. Closing its tab or
AppHost shutdown disposes this AppHost-owned process. Opening a detached browser
window does not create a second process. An exited terminal can remain visible
until disposed; further automation fails.

For a shell instead, choose an installed OS-appropriate executable and argument
list. For a database/cache client, prefer integration `WithRepl` rather than a
hand-written container-exec command.

## Manual terminal prompt: no automatic success on process exit

Choose this when a person must drive the tool. Check availability **before**
creating/starting its process. In this cancel-only example, the user closes the
interaction after inspecting the tool; the command intentionally reports
cancellation, not a fabricated setup success.

```csharp
#pragma warning disable ASPIRETERMINAL001
if (builder.ExecutionContext.IsRunMode)
{
    resource.WithCommand("inspect-tool", "Inspect tool", async context =>
    {
        var interaction = context.Services.GetRequiredService<IInteractionService>();
        if (!interaction.IsAvailable)
        {
            return CommandResults.Failure("An interactive dashboard is required.");
        }

        var terminals = context.Services.GetRequiredService<TerminalService>();
        await using var terminal = terminals.CreateTerminal(new TerminalLaunchOptions
        {
            Title = "Inspect tool",
            Executable = "dotnet",
            Arguments = { toolPath },
            Placement = TerminalPlacement.Dialog
        });
        terminal.Start();

        var result = await interaction.PromptTerminalAsync(
            "Inspect the tool, then cancel to close this session.",
            terminal,
            new TerminalInteractionOptions
            {
                Title = "Inspect tool",
                PrimaryButtonText = "Cancel"
            },
            context.CancellationToken);

        return result.Canceled
            ? CommandResults.Failure("Inspection canceled.")
            : CommandResults.Failure("No tool success condition was defined.");
    });
}
#pragma warning restore ASPIRETERMINAL001
```

`PrimaryButtonText` labels the **cancel** button; there is no button by default,
and secondary/dismiss controls are not shown. Without `Work`, exiting the tool
does **not** close the prompt. For meaningful completion, implement an explicit
completion signal, normally with `Work` waiting for tool output as below.

`IsAvailable` is false if the dashboard/interactivity is disabled or the current
resource-command scope is noninteractive. It does not prove a viewer is currently
connected. If human input is required, report unavailability; do not quietly
switch to headless execution or treat cancellation as success.

## Automated prompt: visible work with a bounded success condition

The example tool asks `Continue?`, accepts `yes`, and emits `Setup complete` only
after successful work. Establish the real protocol from the actual tool. The
completion marker must be fresh output, not text already on screen or in an
echoed input command.

```csharp
#pragma warning disable ASPIRETERMINAL001
if (builder.ExecutionContext.IsRunMode)
{
    resource.WithCommand("setup-tool", "Set up tool", async context =>
    {
        var interaction = context.Services.GetRequiredService<IInteractionService>();
        if (!interaction.IsAvailable)
        {
            return CommandResults.Failure("An interactive dashboard is required.");
        }

        var terminals = context.Services.GetRequiredService<TerminalService>();
        await using var terminal = terminals.CreateTerminal(new TerminalLaunchOptions
        {
            Title = "Tool setup",
            Executable = "dotnet",
            Arguments = { toolPath },
            Placement = TerminalPlacement.Dialog
        });

        var result = await interaction.PromptTerminalAsync(
            "Watch setup; cancel to stop it.",
            terminal,
            new TerminalInteractionOptions
            {
                Title = "Tool setup",
                PrimaryButtonText = "Cancel",
                Work = async terminalContext =>
                {
                    var token = terminalContext.CancellationToken;
                    await terminal.WaitForTextAsync(
                        "Continue?", TimeSpan.FromSeconds(15), token);
                    await terminal.SendTextAsync("yes", token);
                    await terminal.SendKeyAsync(AspireTerminalKey.Enter, token);
                    await terminal.WaitForTextAsync(
                        "Setup complete", TimeSpan.FromSeconds(30), token);
                }
            },
            context.CancellationToken);

        return result.Canceled
            ? CommandResults.Failure("Setup canceled.")
            : CommandResults.Success();
    });
}
#pragma warning restore ASPIRETERMINAL001
```

Automation/viewing starts a terminal lazily; explicitly calling `Start()` is also
valid. `TerminalContext` supplies the callback cancellation token, **not** a
terminal property; close over the registered handle.

Successful `Work` completion closes the dialog. User/external cancellation
signals and joins Work before returning. Pass its token to every operation and
don't swallow cancellation or unrelated exceptions. Prompt removal occurs before
an unrelated callback error propagates. The enclosing `await using` then disposes
the process on success, cancellation or error.

`PromptTerminalAsync` only **borrows** the exact registered Dialog instance from
this AppHost. It neither disposes the terminal nor accepts a Dock/resource
terminal just because its ID/title looks right.

## Headless: same protocol, no user interaction

Use only when a human interaction is not required. This is not an automatic
fallback for unavailable prompts.

```csharp
#pragma warning disable ASPIRETERMINAL001
if (builder.ExecutionContext.IsRunMode)
{
    resource.WithCommand("automate-tool", "Automate tool", async context =>
    {
        var terminals = context.Services.GetRequiredService<TerminalService>();
        await using var terminal = terminals.CreateTerminal(new TerminalLaunchOptions
        {
            Title = "Headless setup",
            Executable = "dotnet",
            Arguments = { toolPath },
            Placement = TerminalPlacement.None
        });

        var token = context.CancellationToken;
        await terminal.WaitForTextAsync("Continue?", TimeSpan.FromSeconds(15), token);
        await terminal.SendTextAsync("yes", token);
        await terminal.SendKeyAsync(AspireTerminalKey.Enter, token);
        await terminal.WaitForTextAsync("Setup complete", TimeSpan.FromSeconds(30), token);
        return CommandResults.Success();
    });
}
#pragma warning restore ASPIRETERMINAL001
```

No dock tab or prompt is created. These APIs expose screen/input, not a public
`ExitCode` or `WaitForExitAsync`. A tool that only communicates success via exit
status may be better run through a normal process API rather than pretending
terminal input delivery proves completion.

## Source evidence

- [Terminal service, handle and options](https://github.com/microsoft/aspire/tree/34db30a7d3733229da64a403dfc4e4e4d7a1a43b/src/Aspire.Hosting/ApplicationModel)
- [Interaction contract](https://github.com/microsoft/aspire/blob/34db30a7d3733229da64a403dfc4e4e4d7a1a43b/src/Aspire.Hosting/IInteractionService.cs)
- [AppHost terminal feature](https://github.com/microsoft/aspire/pull/19887)
- [Public namespace move](https://github.com/microsoft/aspire/pull/20261)
