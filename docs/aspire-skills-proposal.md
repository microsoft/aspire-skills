# Proposal: `aspire-skills` — A Standalone Skills Plugin for Aspire

> **Authors**: @spboyer, with input from Copilot CLI analysis  
> **Status**: Proposal / RFC  
> **Related Issues**: [microsoft/aspire#15801](https://github.com/microsoft/aspire/issues/15801), [microsoft/aspire#15918](https://github.com/microsoft/aspire/pull/15918), [microsoft/aspire#15745](https://github.com/microsoft/aspire/pull/15745)  
> **Model**: [microsoft/azure-skills](https://github.com/microsoft/azure-skills)

---

## TL;DR — What We're Doing and Why

### The Problem

When developers use AI coding agents (Copilot, Claude, Cursor, etc.) with Aspire projects, the agents have **no idea Aspire exists**. They fall back to raw `dotnet run`, manually poll health endpoints with `curl`, run `dotnet build` into file-lock errors, and leave orphaned processes behind. This isn't a minor annoyance — it makes the agent actively harmful to the developer's workflow ([#15801](https://github.com/microsoft/aspire/issues/15801)).

### Why It Happens

Aspire already ships excellent agent guidance via `aspire agent init` — and it just got significantly better with David's [scenario-based skill rewrite](https://github.com/microsoft/aspire/pull/15745) (100% on 319 eval assertions). **But most developers never run `aspire agent init`**, so they get zero Aspire-aware guidance. The skill exists; it just doesn't reach the developer.

### What We're Proposing

An **`aspire-skills` plugin** — a thin, always-on safety net distributed through agent marketplaces (Copilot CLI, Claude Code, Gemini CLI, Cursor). Users install it once and every Aspire project they touch gets baseline protection.

**The plugin is deliberately thin.** It does NOT duplicate David's comprehensive project-local skill. Instead it:

1. **Detects** — Recognizes Aspire AppHost projects (`.csproj` with `Aspire.AppHost.Sdk`, `apphost.ts`)
2. **Guards** — Enforces the critical safety rules that prevent agent self-harm:
   - ✅ `aspire start` — never `dotnet run`
   - ✅ `aspire wait <resource>` — never `curl` health polling
   - ✅ `aspire resource <name> restart` — never `dotnet build` against locked files
   - ✅ `aspire stop` when done — never leave processes running
3. **Bridges** — Routes to the right tool for the job:
   - Local diagnostics → Aspire CLI (`aspire logs`, `aspire otel`, `aspire describe`)
   - Deployed app diagnostics → `azure-diagnostics` from azure-skills (App Insights, ACA logs)
   - Deployment → Aspire's native pipeline (`aspire publish`, `aspire deploy`, `aspire do`)
4. **Recommends** — Tells developers to run `aspire agent init` for comprehensive scenario-based guidance

### How It Fits Together

```
┌─────────────────────────────────────────────────────────────────┐
│  What the developer gets                                        │
│                                                                 │
│  ① aspire-skills plugin (always-on via marketplace)             │
│     → Detects Aspire projects                                   │
│     → Enforces safety guardrails                                │
│     → Bridges local ↔ deployed diagnostics                      │
│     → Recommends aspire agent init                              │
│                                                                 │
│  ② Project-local skill (after aspire agent init)                │
│     → 9 scenario-based reference files (PR #15745)              │
│     → C# and TypeScript AppHost guidance                        │
│     → Playwright handoff, docs-first patterns                   │
│     → 100% eval score on 319 assertions                         │
│                                                                 │
│  ③ aspire-init skill (one-time, from PR #15918)                 │
│     → Guides aspire init for existing apps                      │
│     → Self-deletes after successful aspire start                │
│                                                                 │
│  ④ azure-skills plugin (for production)                         │
│     → azure-diagnostics for deployed app monitoring             │
│     → App Insights queries, ACA logs, az monitor                │
└─────────────────────────────────────────────────────────────────┘
```

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **One thin skill**, not three comprehensive ones | PR #15745 already provides comprehensive coverage; plugin avoids duplication |
| **Plugin, not project-local** | Solves the #1 problem: discoverability. No `aspire agent init` required |
| **Aspire deploys natively** | No azure-skills handoff for deployment — Aspire uses Bicep + Azure SDK directly |
| **azure-diagnostics bridge for production only** | Aspire CLI diagnostics are local-only (backchannel socket); azure-diagnostics fills the deployed gap |
| **Follows azure-skills architecture** | Proven multi-host distribution: Copilot CLI, Claude, Gemini, Cursor |

### What's Below

The rest of this document covers the detailed analysis, architecture, decision tables, workflow diagrams, and open questions for the Aspire team. Start with the [Problem Statement](#problem-statement) for the full #15801 breakdown, or skip to [The Three Skills](#the-three-skills) for the proposed content.

> ⚠️ **Note on scope**: The original proposal below describes three separate skills (orchestration, deployment, monitoring). Based on our analysis of [PR #15745](https://github.com/microsoft/aspire/pull/15745), we now recommend consolidating to **one thin plugin skill** with the comprehensive content deferred to the project-local skill. The detailed skill content below remains useful as reference for what the project-local skill covers vs. what the plugin should enforce.

---

## Problem Statement

### Customer Pain Point: [microsoft/aspire#15801](https://github.com/microsoft/aspire/issues/15801)

A user reported 5 specific failures when using Copilot with an Aspire project:

| # | Complaint | What the Agent Did | What It Should Have Done |
|---|-----------|-------------------|--------------------------|
| 1 | Never uses `aspire start` | Fell back to `dotnet run` | Use `aspire start` to launch the AppHost |
| 2 | Ignores `aspire wait` | Manually polled health endpoints with `curl` | Use `aspire wait <resource>` for readiness |
| 3 | Tries to compile manually | Ran `dotnet build`, hit file-lock errors | Use `aspire resource <name> rebuild` |
| 4 | Ignores file-lock errors | Concluded project is "un-buildable" | Recognize Aspire holds locks; run `aspire stop` first |
| 5 | Leaves Aspire hanging | Didn't stop processes after task completion | Always run `aspire stop` when done |

### Root Cause

The existing Aspire skill lives inside `microsoft/aspire` at `.agents/skills/aspire/` and is only available when a user explicitly runs `aspire agent init`. Most users don't know this command exists, so they get **zero Aspire-specific guidance** from their agent.

### Gap Analysis

```
Today's Landscape:
                                                           
  ┌─────────────────────────────────┐                      
  │  User's Aspire Project          │                      
  │                                 │                      
  │  ❌ No skills installed         │  ← Most users are here
  │     (never ran aspire agent     │     Agent falls back to
  │      init)                      │     generic .NET behavior
  │                                 │                      
  └─────────────────────────────────┘                      
                                                           
  ┌─────────────────────────────────┐                      
  │  User's Aspire Project          │                      
  │                                 │                      
  │  ✅ .agents/skills/aspire/      │  ← Power users who know
  │     (ran aspire agent init)     │     about aspire agent init
  │                                 │                      
  └─────────────────────────────────┘                      

Proposed Landscape:

  ┌─────────────────────────────────┐                      
  │  User's Aspire Project          │                      
  │                                 │                      
  │  ✅ aspire-skills plugin        │  ← ALL users with the  
  │     (always-on via marketplace) │     plugin installed   
  │                                 │                      
  │  ✅ .agents/skills/aspire/      │  ← Optional: deeper     
  │     (optional project-local)    │     project-specific    
  │                                 │     guidance            
  └─────────────────────────────────┘                      
```

---

## How azure-skills Works (The Model)

The `microsoft/azure-skills` repository is the proven model we're following. Here's how it works:

### Architecture

```
azure-skills/
├── plugin.json                    # Primary Copilot CLI manifest
├── .mcp.json                      # MCP server configuration
├── .plugin/plugin.json            # Generic host manifest
├── .claude-plugin/                # Claude Code integration
│   ├── plugin.json
│   └── marketplace.json
├── .cursor-plugin/                # Cursor integration
│   └── marketplace.json
├── gemini-extension.json          # Gemini CLI integration
├── hooks/                         # Telemetry hooks
│   ├── copilot-hooks.json
│   ├── hooks.json
│   └── scripts/
├── skills/                        # 26 Azure skills
│   ├── azure-prepare/
│   │   ├── SKILL.md
│   │   └── references/
│   ├── azure-validate/
│   ├── azure-deploy/
│   ├── azure-diagnostics/
│   └── ... (22 more)
├── .github/plugins/azure-skills/  # Published plugin (mirrors root)
└── README.md
```

### Key Patterns That Make azure-skills Effective

| Pattern | Description | Example |
|---------|-------------|---------|
| **Decision Tables** | Deterministic routing based on conditions | "What changed? → AppHost = restart, .NET project = rebuild, JS = no action" |
| **Mandatory Gating** | Prerequisites enforced before execution | "azure-validate MUST pass before azure-deploy runs" |
| **Safety Guardrails** | Destructive actions require confirmation | "Always `aspire stop` when done" |
| **Progressive Disclosure** | SKILL.md (<5K tokens) + references/ for detail | Main file is concise; deep dives in references/ |
| **Skill Handoff Chains** | Skills invoke other skills in sequence | `azure-prepare` → `azure-validate` → `azure-deploy` |
| **Error Recovery Tables** | Symptom → Cause → Action mappings | "File lock error → Aspire holding locks → `aspire stop`" |

### Distribution

Users install once, skills are always available:

```bash
# Copilot CLI
/plugin install azure@azure-skills

# Claude Code
/plugin install azure@azure-skills

# Gemini CLI
gemini extensions install https://github.com/microsoft/azure-skills
```

---

## Proposed: `aspire-skills` Repository

### Repository Structure

```
aspire-skills/
├── .github/
│   ├── CODEOWNERS
│   └── plugins/
│       └── aspire-skills/              # Published plugin (mirrors root)
│           ├── .plugin/plugin.json
│           ├── .claude-plugin/
│           │   ├── plugin.json
│           │   └── marketplace.json
│           ├── .cursor-plugin/
│           │   └── marketplace.json
│           ├── .mcp.json
│           ├── gemini-extension.json
│           ├── hooks/
│           │   ├── copilot-hooks.json
│           │   ├── hooks.json
│           │   └── scripts/
│           │       ├── track-telemetry.sh
│           │       └── track-telemetry.ps1
│           ├── skills/ → (mirrors root skills/)
│           └── README.md
│
├── plugin.json                         # Root Copilot CLI manifest
├── .plugin/plugin.json                 # Generic host manifest
├── .claude-plugin/
│   ├── plugin.json                     # Claude Code manifest
│   └── marketplace.json                # Claude marketplace
├── .cursor-plugin/
│   └── marketplace.json                # Cursor marketplace
├── .mcp.json                           # MCP servers
├── gemini-extension.json               # Gemini CLI
├── hooks/
│   ├── copilot-hooks.json
│   ├── hooks.json
│   └── scripts/
│       ├── track-telemetry.sh
│       └── track-telemetry.ps1
│
├── skills/                             # ─── ASPIRE SKILLS ───
│   │
│   ├── aspire-orchestration/           # Core lifecycle management
│   │   ├── SKILL.md                    # Decision tables, mandatory rules
│   │   └── references/
│   │       ├── lifecycle-management.md # start/stop/wait/ps/doctor
│   │       ├── code-change-workflow.md # rebuild vs restart patterns
│   │       └── troubleshooting.md      # file locks, compile errors
│   │
│   ├── aspire-deployment/              # Native Azure deployment
│   │   ├── SKILL.md                    # publish/deploy/do pipeline
│   │   └── references/
│   │       ├── deployment-pipeline.md  # Bicep + Azure SDK pipeline
│   │       └── deployment-targets.md   # ACA, ACR, SQL, App Insights
│   │
│   └── aspire-monitoring/              # Observability & diagnostics
│       ├── SKILL.md                    # local: describe/otel/logs; deployed: azure-diagnostics bridge
│       └── references/
│           ├── local-diagnostics.md    # aspire logs/describe/otel/export
│           └── production-monitoring.md # App Insights, ACA logs, azure-diagnostics bridge
│
├── README.md                           # Installation guide
├── CHANGELOG.md
├── LICENSE (MIT)
├── SECURITY.md
├── CODE_OF_CONDUCT.md
└── CONTRIBUTING.md
```

### Plugin Manifest (`plugin.json`)

```json
{
  "name": "aspire",
  "description": "Aspire skills for distributed application orchestration, deployment, and monitoring. Provides agent guidance for Aspire CLI commands, lifecycle management, and observability workflows.",
  "version": "1.0.0",
  "author": {
    "name": "Microsoft",
    "url": "https://www.microsoft.com"
  },
  "homepage": "https://github.com/microsoft/aspire-skills",
  "repository": "https://github.com/microsoft/aspire-skills",
  "license": "MIT",
  "keywords": [
    "aspire",
    "distributed-apps",
    "orchestration",
    "deployment",
    "observability",
    "microsoft",
    "dotnet"
  ],
  "skills": "./skills/",
  "mcpServers": "./.mcp.json",
  "hooks": "./hooks/copilot-hooks.json"
}
```

---

## The Three Skills

### 1. `aspire-orchestration` — Core Lifecycle Management

**This is the primary skill that directly addresses all 5 complaints from #15801.**

#### Trigger Conditions
- AppHost project detected (`.csproj` with `Aspire.AppHost.Sdk`)
- User mentions: "aspire start", "run my app", "start the project", "rebuild", "restart"
- User is working with distributed app resources

#### Decision Tables

**Starting Applications:**

| Condition | Action | Command |
|-----------|--------|---------|
| AppHost project detected | Start with Aspire | `aspire start` |
| AppHost already running | Check status | `aspire ps` |
| Need isolated instance | Start isolated | `aspire start --isolated` |
| ❌ NEVER | Use dotnet run for AppHost | ~~`dotnet run`~~ |

**Handling Code Changes:**

| What Changed | Action | Command |
|--------------|--------|---------|
| AppHost project (Program.cs, .csproj) | Full restart | `aspire stop` → `aspire start` |
| .NET service project (.cs files) | Rebuild single resource | `aspire resource <name> rebuild` |
| JavaScript/Python/Go files | No action needed | File watchers handle it |
| Configuration (appsettings.json) | Depends on resource | Check `aspire describe` first |
| ❌ NEVER | Manual `dotnet build` | ~~`dotnet build`~~ (causes file-lock errors) |

**Waiting for Resources:**

| Scenario | Action | Command |
|----------|--------|---------|
| Need to interact with a resource | Wait for readiness | `aspire wait <resource>` |
| Need to wait for all resources | Wait for each | `aspire wait <r1>` then `aspire wait <r2>` |
| ❌ NEVER | Manual health polling | ~~`curl http://localhost:xxx/health`~~ |

#### Mandatory Rules (Non-Negotiable)

```
⛔ MANDATORY RULES — VIOLATION CAUSES USER FRUSTRATION

1. ALWAYS use `aspire start` to launch AppHost projects.
   NEVER use `dotnet run` — it bypasses orchestration.

2. ALWAYS use `aspire wait <resource>` before interacting with a resource.
   NEVER manually poll health endpoints — Aspire tracks readiness.

3. ALWAYS use `aspire resource <name> rebuild` for .NET project changes.
   NEVER run `dotnet build` manually — Aspire holds file locks.

4. ALWAYS run `aspire stop` when the task is complete.
   Leaving Aspire running causes file locks and port conflicts.

5. ALWAYS use `--format Json` for machine-readable output.
   Parse JSON output instead of scraping text.
```

#### Error Recovery Table

| Error / Symptom | Cause | Recovery Action |
|----------------|-------|-----------------|
| `MSB3491: Could not write to output file` (file lock) | Aspire holds locks on running projects | `aspire stop` → make changes → `aspire start` |
| `IOException: The process cannot access the file` | Same as above | `aspire stop` → make changes → `aspire start` |
| Build succeeds but app doesn't update | Rebuilt wrong project | `aspire resource <name> rebuild` (not `dotnet build`) |
| Health check timeout | Resource not ready | `aspire wait <resource>` (not manual curl) |
| `Address already in use` (port conflict) | Another Aspire instance running | `aspire ps` → `aspire stop` the other instance |
| `aspire start` fails | Environment issue | `aspire doctor` to diagnose |

#### Handoff

When user wants to deploy to Azure: → **aspire-deployment** skill  
When user wants to check logs/traces: → **aspire-monitoring** skill

---

### 2. `aspire-deployment` — Native Azure Deployment

> **Key Finding**: Aspire handles Azure deployment **end-to-end natively** using Bicep + Azure SDK. There is **no handoff** to azure-skills or azd. The entire pipeline runs inside the AppHost.

#### Trigger Conditions
- User mentions: "deploy", "publish", "push to Azure", "ship it", "go live"
- User wants to move from local dev to cloud

#### How Aspire Deployment Works

```
AppHost Code                    Aspire Pipeline                 Azure
┌─────────────────┐            ┌──────────────────┐           ┌──────────┐
│ .AddProject()   │   aspire   │ BeforePublish     │  Azure    │ ACA      │
│ .AddRedis()     │──publish──→│ Generate Bicep    │──SDK────→ │ ACR      │
│ .AddPostgres()  │            │ Build containers  │  deploy   │ SQL      │
│ .PublishAs...() │            │ Push to ACR       │           │ AppInsights│
└─────────────────┘            └──────────────────┘           └──────────┘
```

**The pipeline runs inside the AppHost** — not via external tooling:
1. `aspire publish` invokes the AppHost via `dotnet run --project <AppHost.csproj> -- --operation publish` (users never run this directly)
2. AppHost generates Bicep templates from resource definitions
3. Bicep compiled to ARM via local `BicepCliCompiler`
4. Azure SDK deploys ARM templates directly to subscription
5. Container images pushed to Azure Container Registry
6. Status streamed back via RPC backchannel

#### Deployment Decision Table

| Scenario | Command | What Happens |
|----------|---------|--------------|
| Generate artifacts only | `aspire publish` | Bicep templates + container images → output directory |
| Full deploy (first time or update) | `aspire deploy` | Run complete pipeline (publish + deploy steps) |
| Reset and redeploy | `aspire deploy --clear-cache` | Clear deployment state, full redeploy |
| Run one pipeline step | `aspire do <step>` | e.g., `aspire do seed-data`, `aspire do push-containers` |
| Custom output | `aspire publish --output-path ./manifest` | Artifacts to specific directory |

#### Primary Azure Targets

| Target | AppHost API | Auto-Provisioned |
|--------|-------------|-------------------|
| Azure Container Apps | `.PublishAsAzureContainerApp()` | ✅ Primary compute target |
| Container App Jobs | `.PublishAsAzureContainerAppJob()` | ✅ For scheduled/manual work |
| Azure Container Registry | Auto-configured | ✅ Image repository |
| Azure SQL Database | `.PublishAsAzureSqlDatabase()` | ✅ Connection strings wired |
| Application Insights | `.AddAzureApplicationInsights()` | ✅ Telemetry auto-configured |
| Any Azure resource | Via Bicep templates | ✅ Using `Azure.Provisioning` SDK |

#### ⚠️ No External Tooling Required

| Myth | Reality |
|------|---------|
| ~~Needs azd~~ | Aspire has its own pipeline; azd is optional |
| ~~Needs azure-prepare skill~~ | AppHost IS the deployment plan |
| ~~Needs Bicep CLI installed~~ | Aspire includes `BicepCliCompiler` |
| ~~Needs azure-deploy skill~~ | `aspire deploy` handles everything |

---

### 3. `aspire-monitoring` — Observability & Diagnostics

#### Trigger Conditions
- User mentions: "logs", "traces", "metrics", "what's happening", "debug", "dashboard"
- Resource appears unhealthy
- User wants to export telemetry

#### Critical: Local vs Deployed Diagnostics

Aspire CLI diagnostics are **local-only** by design. For deployed apps, a different approach is needed.

**Local Development (full CLI support):**

| Need | Command | Output |
|------|---------|--------|
| Resource state overview | `aspire describe --format Json` | JSON with status, endpoints, health |
| Application logs | `aspire logs <resource>` | Stdout/stderr from resource |
| Stream logs | `aspire logs --follow` | Real-time log streaming |
| OpenTelemetry logs | `aspire otel logs` | Structured OTel log records |
| Distributed traces | `aspire otel traces` | Trace spans with correlation |
| Individual spans | `aspire otel spans` | Span-level detail |
| Filter by trace | `aspire otel logs --trace-id <id>` | Correlated logs for one request |
| Export telemetry | `aspire export` | Portable telemetry bundle |

**Deployed Apps (Aspire CLI does NOT connect remotely):**

| Command | Local | Deployed | Via `--dashboard-url` |
|---------|-------|----------|-----------------------|
| `aspire logs` | ✅ | ❌ | ❌ |
| `aspire describe` | ✅ | ❌ | ❌ |
| `aspire otel logs` | ✅ | ❌ | ✅ (if Dashboard deployed) |
| `aspire otel traces` | ✅ | ❌ | ✅ (if Dashboard deployed) |
| Application Insights | ✅ Auto | ✅ Auto | N/A |

> **Why**: `aspire logs` and `aspire describe` use a local backchannel socket (`~/.aspire/backchannels/`). There's no remote connection capability — this is intentional.

#### Production Monitoring Strategy

Aspire auto-configures Application Insights when `AddAzureApplicationInsights()` is used. Deployed apps export OTEL telemetry to App Insights automatically. For querying production telemetry:

1. **Aspire Dashboard deployed remotely** → `aspire otel --dashboard-url <url>`
2. **Application Insights** → Use Azure Portal or azure-diagnostics skill
3. **Azure Container Apps logs** → `az containerapp logs show` (via azure-diagnostics)

#### Bridge to azure-diagnostics (Deployed Apps Only)

```
                Local Dev                     Production
            ┌─────────────────┐          ┌─────────────────┐
            │ aspire-monitoring│          │ azure-diagnostics│
            │ (Aspire CLI)    │          │ (azure-skills)   │
            │                 │          │                  │
            │ • aspire logs   │          │ • az monitor     │
            │ • aspire describe│         │ • App Insights   │
            │ • aspire otel   │          │ • ACA logs       │
            │ • aspire export │          │ • az containerapp│
            └─────────────────┘          └─────────────────┘
                    │                            │
                    └──────── Decision ──────────┘
                              │
                    Is the app running locally?
                    Yes → aspire-monitoring
                    No  → azure-diagnostics
```

---

## Workflow Diagrams

### End-to-End Developer Workflow

```
Developer starts working on Aspire project
                    │
                    ▼
        ┌───────────────────────┐
        │  aspire-skills plugin │ ← Installed via marketplace
        │  (always available)   │    (no aspire agent init needed)
        └───────────┬───────────┘
                    │
         ┌──────────┼──────────┐
         │          │          │
         ▼          ▼          ▼
   ┌──────────┐ ┌────────┐ ┌──────────┐
   │orchestr- │ │deploy- │ │monitor-  │
   │ation     │ │ment    │ │ing       │
   │          │ │        │ │          │
   │• start   │ │• pub   │ │• logs    │  Local: aspire CLI
   │• rebuild │ │• deploy│ │• traces  │
   │• wait    │ │• do    │ │• export  │
   │• stop    │ │        │ │• describe│
   └──────────┘ └────────┘ └─────┬────┘
                                 │
                    Is it deployed? (not local)
                                 │
                                 ▼
                          ┌──────────────┐
                          │ azure-skills │  ← Only for
                          │ plugin       │     production
                          │              │     diagnostics
                          │ diagnostics  │
                          │ (App Insights│
                          │  ACA logs)   │
                          └──────────────┘
```

### Lifecycle Management Workflow (Addressing #15801)

```
User: "Make a change to the API service"
                    │
                    ▼
    ┌─────────────────────────────┐
    │ Is Aspire running?          │
    │ (aspire ps)                 │
    └──────┬──────────────┬───────┘
           │              │
        No ▼           Yes ▼
    ┌──────────┐   ┌──────────────────┐
    │ aspire   │   │ What changed?     │
    │ start    │   └──┬───────┬───────┘
    └──────────┘      │       │       │
                      ▼       ▼       ▼
              ┌────────┐ ┌──────┐ ┌────────┐
              │AppHost │ │.NET  │ │JS/Py   │
              │changed │ │svc   │ │files   │
              │        │ │code  │ │        │
              └───┬────┘ └──┬───┘ └───┬────┘
                  │         │         │
                  ▼         ▼         ▼
            ┌─────────┐ ┌────────┐ ┌─────────┐
            │aspire   │ │aspire  │ │No action│
            │stop →   │ │resource│ │(file    │
            │edit →   │ │<name>  │ │watchers)│
            │aspire   │ │rebuild │ │         │
            │start    │ │        │ │         │
            └─────────┘ └────────┘ └─────────┘
                  │         │
                  ▼         ▼
            ┌─────────────────────┐
            │ aspire wait <res>   │  ← ALWAYS wait
            │ before interacting  │     NEVER manual poll
            └─────────────────────┘
                      │
                      ▼
            ┌─────────────────────┐
            │ Do the work...      │
            └─────────────────────┘
                      │
                      ▼
            ┌─────────────────────┐
            │ aspire stop         │  ← ALWAYS cleanup
            │ when task complete  │     NEVER leave running
            └─────────────────────┘
```

### File-Lock Error Recovery (The #1 Frustration)

```
User makes a code change while Aspire is running
                    │
                    ▼
    Agent tries: dotnet build  ← ❌ WRONG (old behavior)
                    │
                    ▼
    ╔═══════════════════════════════════╗
    ║ MSB3491: Could not write to      ║
    ║ output file — file is locked     ║
    ╚═══════════════════════════════════╝
                    │
                    ▼
    ┌───────────────────────────────────┐
    │ WITH aspire-skills plugin:        │
    │                                   │
    │ 1. Recognize: Aspire holds locks  │
    │ 2. DON'T try dotnet build again   │
    │ 3. Use: aspire resource <name>    │
    │         rebuild                   │
    │    (Aspire rebuilds internally,   │
    │     managing its own locks)       │
    │                                   │
    │ If rebuild fails:                 │
    │ 4. aspire stop                    │
    │ 5. Make changes                   │
    │ 6. aspire start                   │
    └───────────────────────────────────┘
```

### Skill Ecosystem Relationships

```
┌─────────────────────────────────────────────────────────────┐
│                    User's Development Environment           │
│                                                             │
│  ┌─────────────────────┐  ┌──────────────────────────────┐  │
│  │  aspire-skills       │  │  azure-skills                │  │
│  │  (plugin, always-on) │  │  (plugin, always-on)         │  │
│  │                      │  │                              │  │
│  │  • orchestration     │  │  • prepare/validate/deploy   │  │
│  │  • deployment        │  │  • diagnostics ←─────────────│──│─┐
│  │  • monitoring ───────│──│→ (deployed app diagnostics)  │  │ │
│  └─────────────────────┘  └──────────────────────────────┘  │ │
│                                                             │ │
│  Aspire deploys to Azure natively (Bicep + Azure SDK).      │ │
│  azure-diagnostics helps ONLY for production monitoring     │ │
│  of already-deployed apps (App Insights, ACA logs).       ←─│─┘
│                                                             │
│  ┌─────────────────────────────────────────────────────────┐│
│  │  Project-Local Skills (optional, from aspire agent init)││
│  │                                                         ││
│  │  .agents/skills/aspire/        ← Evergreen AppHost skill││
│  │  .agents/skills/aspire-init/   ← One-time init (PR#15918)│
│  │  .agents/skills/playwright-cli/← Browser testing        ││
│  └─────────────────────────────────────────────────────────┘│
│                                                             │
│  Plugin skills provide baseline coverage.                   │
│  Project-local skills provide deeper, project-specific      │
│  guidance when installed.                                   │
└─────────────────────────────────────────────────────────────┘
```

---

## How This Relates to Existing Aspire Skills Work

### Current State: `aspire agent init` (main branch)

The Aspire CLI already ships skills embedded in the binary:

```csharp
// SkillDefinition.cs
public static readonly SkillDefinition Aspire = new(
    name: "aspire",
    embeddedResourceRoot: "skills.aspire",
    isDefault: true
);
```

Running `aspire agent init` extracts these to the project:
- `.agents/skills/aspire/SKILL.md` + 9 reference files
- Supports multiple locations: `.agents/skills/`, `.claude/skills/`, `.github/skills/`, `.opencode/skill/`

**Limitation**: User must know to run `aspire agent init`. Most users don't.

### Maddy's Spike: Skill-Driven Init (PR #15918)

Maddy's PR refactors `aspire init` from ~980 lines to a thin skeleton that delegates to a skill:

```
Before: aspire init → 980 lines of C# code doing everything
After:  aspire init → drops skeleton AppHost → triggers aspire-init skill
```

Key characteristics of the aspire-init skill:
- **One-time** — self-deletes after successful `aspire start`
- **Comprehensive** — repo scanning, dependency wiring, ServiceDefaults, OTel setup
- **Eval-tested** — 97% on .NET traditional app, 94% on polyglot app
- **Guiding principles**: Minimize code changes, surface tradeoffs, when in doubt ask

### Proposed: aspire-skills Plugin (This Proposal)

| Aspect | `aspire agent init` | PR #15918 aspire-init | **aspire-skills plugin** |
|--------|--------------------|-----------------------|--------------------------|
| **Scope** | Project-local | Project-local | Plugin-level (always-on) |
| **Install** | `aspire agent init` | `aspire init` | Marketplace install |
| **Lifetime** | Evergreen | One-time (self-deletes) | Evergreen |
| **Purpose** | AppHost guidance | Project initialization | Lifecycle orchestration |
| **Discoverability** | Must know command | Automatic with init | Automatic with plugin |
| **User requirement** | Run command in project | Run `aspire init` | Install plugin once |

**These three are complementary, not competing:**

1. **aspire-skills plugin** → Always-on baseline ("never use dotnet run, always aspire start")
2. **aspire agent init skills** → Deep project-specific guidance (resource management, monitoring details)
3. **aspire-init skill** → One-time setup that disappears after init completes

---

## Distribution Channels

### Marketplace Installation (Day 1)

```bash
# Copilot CLI
/plugin install aspire@aspire-skills

# Claude Code
/plugin install aspire@aspire-skills

# Gemini CLI
gemini extensions install https://github.com/microsoft/aspire-skills

# Cursor — via marketplace UI
```

### `aspire skills init` (Future CLI Integration)

A future Aspire CLI command that installs aspire-skills into a project:

```bash
# Install aspire-skills to project for deeper integration
aspire skills init

# This would:
# 1. Download latest skills from microsoft/aspire-skills
# 2. Write to .agents/skills/ (or .claude/skills/, etc.)
# 3. Support same location selection as aspire agent init
```

This is analogous to how `aspire agent init` works today but pulls from the aspire-skills repo instead of embedded resources.

### New Project Scaffolding (Future Template Integration)

```bash
# aspire new could include skills in the template
aspire new --template web-api

# Generated project includes:
# .agents/skills/aspire-orchestration/
# .agents/skills/aspire-deployment/
# .agents/skills/aspire-monitoring/
```

---

## Implementation Plan

### Phase 1: Repository Scaffold
Create the repo with all infrastructure files following azure-skills patterns:
- Plugin manifests (plugin.json, host-specific manifests)
- MCP configuration
- Telemetry hooks
- Repo governance files (LICENSE, SECURITY, CONTRIBUTING, CODE_OF_CONDUCT)
- README with installation instructions for all hosts

### Phase 2: Core Skills (MVP)
Create the 3 skills that directly address #15801:
- `aspire-orchestration` — The critical skill with decision tables, mandatory rules, error recovery
- `aspire-deployment` — Native Azure deployment pipeline (publish/deploy/do)
- `aspire-monitoring` — Observability: local CLI + azure-diagnostics bridge for production

### Phase 3: Testing & Validation
- Manual testing against the #15801 scenario
- Consider eval rubric pattern from Maddy's PR #15918
- Validate skill triggers fire correctly in each host

### Phase 4: Distribution
- Register in Copilot CLI marketplace
- Register in Claude Code marketplace
- Publish Gemini extension
- Publish Cursor plugin

### Phase 5: CLI Integration (coordinate with Aspire team)
- Propose `aspire skills init` command to microsoft/aspire
- Propose template integration with `aspire new`
- Coordinate with existing `aspire agent init` workflow

---

## Open Questions for @davidfowl and @maddymontaquila

1. **Repo home**: Should this live at `microsoft/aspire-skills` (separate repo) or as a directory in `microsoft/aspire`?

2. **Skill overlap**: The aspire-orchestration skill covers some of the same territory as the existing `.agents/skills/aspire/` skill. How should we handle precedence when both are present? Should plugin skills defer to project-local skills?

3. **CLI integration**: Would you accept a PR adding `aspire skills init` to the CLI that pulls from this repo? Or should we propose a different integration mechanism?

4. **MCP server**: Are there plans for an Aspire MCP server (like `@azure/mcp`)? If so, the plugin could wire to it in `.mcp.json` for richer tool integration beyond CLI commands.

5. **Maddy's aspire-init skill**: The aspire-init skill from PR #15918 is one-time and self-deleting. Should aspire-skills include a similar init skill, or should that remain exclusively in the Aspire CLI?

6. **Telemetry**: Should aspire-skills track usage via the same telemetry hooks as azure-skills, or use a different mechanism?

7. **Release coordination**: Should aspire-skills versions align with Aspire CLI releases, or have an independent release cycle?

---

## Appendix: Aspire CLI Command Reference

Commands that the skills would guide agents to use:

| Command | Purpose | Used By Skill |
|---------|---------|---------------|
| `aspire start` | Start AppHost (non-blocking) | orchestration |
| `aspire stop` | Stop AppHost | orchestration |
| `aspire run` | Start AppHost (blocking) | orchestration |
| `aspire wait <resource>` | Wait for resource readiness | orchestration |
| `aspire resource <name> rebuild` | Rebuild single .NET project | orchestration |
| `aspire ps` | List running AppHosts | orchestration |
| `aspire doctor` | Environment diagnostics | orchestration |
| `aspire describe --format Json` | Machine-readable state | monitoring |
| `aspire logs <resource>` | Resource logs | monitoring |
| `aspire otel logs` | OpenTelemetry logs | monitoring |
| `aspire otel traces` | Distributed traces | monitoring |
| `aspire export` | Export telemetry snapshot | monitoring |
| `aspire publish` | Generate deployment manifests | deployment |
| `aspire deploy` | Deploy to target | deployment |
| `aspire do <step>` | Run individual pipeline step | deployment |
| `aspire docs search` | Search documentation | all |
| `aspire docs get` | Get specific doc | all |
