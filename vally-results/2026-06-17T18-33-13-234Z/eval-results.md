## Eval Results

> Timestamp: 2026-06-17T18:33:28.036Z

### aspire-deployment-eval [gpt-5-mini] (/home/runner/work/aspire-skills/aspire-skills/skills/aspire-deployment/evals/eval.yaml)

Evaluates the aspire-deployment skill for correct multi-target deployment guidance, pipeline step handling, and ensuring no handoff to azure-skills for Aspire deployments.

_No stimuli were executed._


> Model: gpt-5-mini | Executor: copilot-sdk

<hr>

### aspire-init-eval [gpt-5-mini] (/home/runner/work/aspire-skills/aspire-skills/skills/aspire-init/evals/eval.yaml)

Evaluates the aspire-init skill for correct first-run guidance: choosing between 'aspire new' and 'aspire init', dropping the skeleton, handing off to 'aspireify' for wiring, and never re-initializing a repo that already has an AppHost.

_No stimuli were executed._


> Model: gpt-5-mini | Executor: copilot-sdk

<hr>

### aspire-monitoring-eval [gpt-5-mini] (/home/runner/work/aspire-skills/aspire-skills/skills/aspire-monitoring/evals/eval.yaml)

Evaluates the aspire-monitoring skill for correct diagnostics routing between local Aspire CLI and deployed platform-specific tools. Tests the bridge logic that is the skill's primary value.

_No stimuli were executed._


> Model: gpt-5-mini | Executor: copilot-sdk

<hr>

### aspire-orchestration-eval [gpt-5-mini] (/home/runner/work/aspire-skills/aspire-skills/skills/aspire-orchestration/evals/eval.yaml)

Evaluates the aspire-orchestration skill against the 5 core complaints from microsoft/aspire#15801 plus detection, worktree, and agent-mode scenarios.

_No stimuli were executed._


> Model: gpt-5-mini | Executor: copilot-sdk

<hr>

### aspire-router-eval [gpt-5-mini] (/home/runner/work/aspire-skills/aspire-skills/skills/aspire/evals/eval.yaml)

Evaluates the top-level aspire router skill for correct sub-skill routing. Tests that prompts are directed to aspire-orchestration, aspire-deployment, or aspire-monitoring based on intent.

_No stimuli were executed._


> Model: gpt-5-mini | Executor: copilot-sdk

<hr>

### aspireify-eval [gpt-5-mini] (/home/runner/work/aspire-skills/aspire-skills/skills/aspireify/evals/eval.yaml)

Evaluates the aspireify skill for correct agentic AppHost wiring guidance: language-aware authoring (C#, file-based C#, TypeScript), current Aspire features (unified withEnvironment, AddNextJsApp, WithBrowserLogs, ExcludeReferenceEndpoint), ServiceDefaults wiring, validation flow, and proper hand-off to other Aspire skills.

_No stimuli were executed._


> Model: gpt-5-mini | Executor: copilot-sdk
