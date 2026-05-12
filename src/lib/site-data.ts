import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";

const root = process.cwd();

type SkillFrontmatter = {
  name?: string;
  description?: string;
  metadata?: {
    version?: string;
  };
};

export type SkillCard = {
  name: string;
  scenario: string;
  role: string;
  summary: string;
  description: string;
  version: string;
  command: string;
  commandHref: string;
  highlights: string[];
  icon: string;
  href: string;
  order: number;
};

type SkillProfile = {
  scenario: string;
  role: string;
  summary: string;
  command: string;
  commandHref: string;
  highlights: string[];
  icon: string;
  order: number;
};

const aspireCliDocsRoot = "https://aspire.dev/reference/cli/commands";

const skillProfiles: Record<string, SkillProfile> = {
  aspire: {
    scenario: "Detect and route",
    role: "Always-on safety net",
    summary: "Recognizes Aspire context and routes each task to the right workflow.",
    command: "aspire start",
    commandHref: `${aspireCliDocsRoot}/aspire-start/`,
    highlights: ["Detects AppHosts", "Routes to sub-skills", "Keeps guardrails active"],
    icon: "lucide:route",
    order: 0
  },
  "aspire-init": {
    scenario: "Bootstrap",
    role: "First-run setup",
    summary: "Chooses a starter or skeleton for repos that do not have an AppHost yet.",
    command: "aspire init",
    commandHref: `${aspireCliDocsRoot}/aspire-init/`,
    highlights: ["Chooses init vs new", "Drops AppHost skeleton", "Hands off to aspireify"],
    icon: "lucide:package-plus",
    order: 1
  },
  aspireify: {
    scenario: "Wire the AppHost",
    role: "Resource graph authoring",
    summary: "Turns an AppHost skeleton into a modeled resource graph.",
    command: "aspire add",
    commandHref: `${aspireCliDocsRoot}/aspire-add/`,
    highlights: ["Scans projects", "Models services", "Never edits .modules"],
    icon: "lucide:network",
    order: 2
  },
  "aspire-orchestration": {
    scenario: "Run safely",
    role: "Lifecycle guardrails",
    summary: "Runs the app through Aspire and recovers cleanly from local lifecycle issues.",
    command: "aspire wait <resource>",
    commandHref: `${aspireCliDocsRoot}/aspire-wait/`,
    highlights: ["Starts the orchestrator", "Waits for readiness", "Recovers from file locks"],
    icon: "lucide:orbit",
    order: 3
  },
  "aspire-deployment": {
    scenario: "Ship and tear down",
    role: "Native deployment",
    summary: "Publishes, deploys, and destroys using Aspire's deployment pipeline.",
    command: "aspire deploy",
    commandHref: `${aspireCliDocsRoot}/aspire-deploy/`,
    highlights: ["Publishes artifacts", "Deploys across targets", "Uses aspire destroy"],
    icon: "lucide:rocket",
    order: 4
  },
  "aspire-monitoring": {
    scenario: "Observe and diagnose",
    role: "Telemetry bridge",
    summary: "Uses local Aspire telemetry and routes deployed diagnostics to the right tools.",
    command: "aspire otel traces",
    commandHref: `${aspireCliDocsRoot}/aspire-otel-traces/`,
    highlights: ["Reads local telemetry", "Finds hidden resources", "Routes deployed diagnostics"],
    icon: "lucide:activity",
    order: 5
  }
};

export type InstallSurface = {
  id: string;
  name: string;
  shortName: string;
  detail: string;
  command: string;
  badge: string;
  status: string;
  language: string;
  title: string;
  icon: "aspire" | "claude" | "copilot" | "cursor" | "gemini" | "npm" | "ollama" | "openai" | "opencode";
  notes: string[];
};

export type Guardrail = {
  label: string;
  command: string;
  commandHref: string;
  why: string;
  icon: string;
};

export type EvalSummary = {
  taskCount: string;
  triggerCount: string;
  focus: string;
  focusAreas: string[];
};

export async function getSiteData() {
  const [skills, pluginManifest, claudeMarketplace, cursorManifest, geminiManifest, evalSummary] = await Promise.all([
    getSkills(),
    readJson(".plugin/plugin.json"),
    readJson(".claude-plugin/marketplace.json"),
    readJson(".cursor-plugin/marketplace.json"),
    readJson("gemini-extension.json"),
    getEvalSummary()
  ]);

  return {
    skills,
    manifests: {
      plugin: pluginManifest,
      claude: claudeMarketplace,
      cursor: cursorManifest,
      gemini: geminiManifest
    },
    installSurfaces: getInstallSurfaces(pluginManifest.version, claudeMarketplace.plugins?.[0]?.version ?? pluginManifest.version),
    evalSummary,
    guardrails: [
      {
        label: "Start the app",
        command: "aspire start",
        commandHref: `${aspireCliDocsRoot}/aspire-start/`,
        why: "Launch the full AppHost resource graph through the orchestrator.",
        icon: "lucide:play"
      },
      {
        label: "Wait for readiness",
        command: "aspire wait <resource>",
        commandHref: `${aspireCliDocsRoot}/aspire-wait/`,
        why: "Use Aspire's readiness model before touching a service.",
        icon: "lucide:timer"
      },
      {
        label: "Apply code changes",
        command: "aspire resource <name> restart",
        commandHref: `${aspireCliDocsRoot}/aspire-resource/`,
        why: "Restart only the changed resource while preserving the running graph.",
        icon: "lucide:refresh-cw"
      },
      {
        label: "Tear down deployments",
        command: "aspire destroy",
        commandHref: `${aspireCliDocsRoot}/aspire-destroy/`,
        why: "Unwind Azure, Kubernetes, or Compose resources through Aspire.",
        icon: "lucide:trash-2"
      }
    ],
    architecture: [
      { label: "Marketplace plugin guardrails", icon: "lucide:shield-check" },
      { label: "Project-local aspire agent init guidance", icon: "lucide:file-text" },
      { label: "aspire-init and aspireify setup loop", icon: "lucide:workflow" },
      { label: "Azure diagnostics bridge for deployed apps", icon: "lucide:activity" }
    ]
  };
}

async function getSkills(): Promise<SkillCard[]> {
  const skillsRoot = path.join(root, "skills");
  const entries = await readdir(skillsRoot, { withFileTypes: true });
  const skillCards = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const filePath = path.join(skillsRoot, entry.name, "SKILL.md");
        const file = await readFile(filePath, "utf8");
        const parsed = matter(file);
        const data = parsed.data as SkillFrontmatter;
        const name = data.name ?? entry.name;
        const profile = skillProfiles[name] ?? {
          scenario: toTitleCase(name),
          role: "Aspire skill",
          summary: "Adds focused Aspire guidance for a specific development workflow.",
          command: "aspire",
          commandHref: `${aspireCliDocsRoot}/aspire/`,
          highlights: ["Guides Aspire workflows", "Keeps context close", "Stays current with the skill"],
          icon: "lucide:sparkles",
          order: 99
        };

        return {
          name,
          scenario: profile.scenario,
          role: profile.role,
          summary: profile.summary,
          command: profile.command,
          commandHref: profile.commandHref,
          highlights: profile.highlights,
          icon: profile.icon,
          order: profile.order,
          version: data.metadata?.version ?? "unversioned",
          description: cleanDescription(data.description ?? firstParagraph(parsed.content)),
          href: `https://github.com/microsoft/aspire-skills/tree/main/skills/${entry.name}`
        };
      })
  );

  return skillCards.sort((left, right) => left.order - right.order || left.name.localeCompare(right.name));
}

async function readJson(relativePath: string) {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}

async function getEvalSummary(): Promise<EvalSummary> {
  const readme = await readFile(path.join(root, "evals", "README.md"), "utf8");
  const totalRow = readme.match(/\|\s*\*\*Total\*\*\s*\|\s*\*\*(?<tasks>[^*]+)\*\*\s*\|\s*\*\*(?<triggers>[^*]+)\*\*\s*\|\s*(?<focus>[^|]+)\|/);
  const focusAreas = readme
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("| `"))
    .map((line) => line.split("|").map((cell) => cell.trim()))
    .filter((cells) => cells.length >= 5)
    .map((cells) => stripMarkdown(cells[4]))
    .filter(Boolean);

  if (!totalRow?.groups) {
    throw new Error("Unable to find eval totals in evals/README.md");
  }

  return {
    taskCount: totalRow.groups.tasks.trim(),
    triggerCount: totalRow.groups.triggers.trim(),
    focus: focusAreas.join(" · "),
    focusAreas
  };
}

function getInstallSurfaces(pluginVersion: string, marketplaceVersion: string): InstallSurface[] {
  return [
    {
      id: "aspire",
      name: "Aspire CLI",
      shortName: "Aspire",
      badge: "first-party",
      status: "Built-in agent setup",
      detail: "Use Aspire's first-party agent setup when creating a new app, adding Aspire to an existing repo, or refreshing agent guidance later.",
      command: "aspire new\n# select y when prompted to configure AI agent environments\n\naspire init\n# select y when prompted to install Aspire agent guidance\n\naspire agent init",
      language: "bash",
      title: "Aspire CLI",
      icon: "aspire",
      notes: [
        "The official path installs Aspire skill files and MCP configuration into detected agent environments.",
        "Run aspire agent init any time to add, update, or reconfigure Aspire guidance in an existing workspace."
      ]
    },
    {
      id: "copilot",
      name: "GitHub Copilot CLI",
      shortName: "Copilot",
      badge: `plugin v${pluginVersion}`,
      status: "Plugin marketplace",
      detail: "Add the Aspire skills marketplace once, then install the plugin by name.",
      command: "copilot plugin marketplace add microsoft/aspire-skills\ncopilot plugin install aspire@aspire-skills",
      language: "bash",
      title: "GitHub Copilot CLI",
      icon: "copilot",
      notes: [
        "Gives Copilot CLI Aspire-specific guidance for AppHost, lifecycle, deployment, and diagnostics tasks.",
        "Best for terminal workflows where agents need to stay aligned with Aspire commands."
      ]
    },
    {
      id: "claude",
      name: "Claude Code CLI",
      shortName: "Claude",
      badge: `v${marketplaceVersion}`,
      status: "CLI plugin",
      detail: "Start Claude Code in your terminal, add the Aspire marketplace, then install the Aspire plugin.",
      command: "claude\n/plugin marketplace add microsoft/aspire-skills\n/plugin install aspire@aspire-skills",
      language: "bash",
      title: "Claude Code CLI",
      icon: "claude",
      notes: [
        "Keeps Claude Code focused on Aspire CLI workflows when editing AppHosts.",
        "Run the slash commands inside the Claude Code CLI session."
      ]
    },
    {
      id: "codex",
      name: "Codex CLI",
      shortName: "Codex",
      badge: "plugin",
      status: "Plugin install",
      detail: "Add the Aspire marketplace, then install Aspire from the Codex plugins UI.",
      command: "codex plugin marketplace add microsoft/aspire-skills\n# then open /plugins and install aspire",
      language: "bash",
      title: "Codex CLI",
      icon: "openai",
      notes: [
        "Keeps Codex CLI focused on Aspire-native setup, orchestration, and diagnostics.",
        "Use it for terminal-first agent work that needs repeatable Aspire guardrails."
      ]
    },
    {
      id: "gemini",
      name: "Gemini CLI",
      shortName: "Gemini",
      badge: "extension",
      status: "Git extension",
      detail: "Install Aspire skills directly from GitHub with Gemini CLI extensions.",
      command: "gemini extensions install https://github.com/microsoft/aspire-skills",
      language: "bash",
      title: "Gemini CLI",
      icon: "gemini",
      notes: [
        "Adds Aspire setup, run, deploy, and monitoring guidance to Gemini CLI.",
        "Use it when Gemini is the agent host for Aspire app work."
      ]
    },
    {
      id: "cursor",
      name: "Cursor CLI",
      shortName: "Cursor",
      badge: "agent",
      status: "CLI skill directory",
      detail: "Install Aspire skills into Cursor's user skill directory, then start Cursor Agent from the terminal.",
      command: "mkdir -p ~/.cursor/skills\ngit clone https://github.com/microsoft/aspire-skills ~/.cursor/skills/aspire-skills\nagent",
      language: "bash",
      title: "Cursor CLI",
      icon: "cursor",
      notes: [
        "Cursor Agent discovers skills from ~/.cursor/skills and .cursor/skills when it starts.",
        "Use this for terminal-first Cursor Agent sessions."
      ]
    },
    {
      id: "opencode",
      name: "OpenCode",
      shortName: "OpenCode",
      badge: "APM",
      status: "OpenCode-compatible",
      detail: "Use APM to install Aspire skills into agent hosts that support OpenCode-compatible skill locations.",
      command: "apm install microsoft/aspire-skills\nopencode",
      language: "bash",
      title: "OpenCode",
      icon: "opencode",
      notes: [
        "Brings Aspire guidance to agent hosts that share OpenCode-compatible skill locations.",
        "Use it when APM is your preferred way to manage agent skills."
      ]
    },
    {
      id: "ollama",
      name: "Ollama + Copilot CLI",
      shortName: "Ollama",
      badge: "local models",
      status: "Runtime bridge",
      detail: "Use Ollama to launch Copilot CLI with an open model, then install the Aspire plugin through Copilot.",
      command: "ollama launch copilot\ncopilot plugin marketplace add microsoft/aspire-skills\ncopilot plugin install aspire@aspire-skills",
      language: "bash",
      title: "Ollama with Copilot CLI",
      icon: "ollama",
      notes: [
        "Run Copilot CLI with a local model while keeping the same Aspire plugin guidance.",
        "Good for developers who want local model execution with Aspire-aware workflows."
      ]
    },
    {
      id: "npx",
      name: "skills.sh via NPX",
      shortName: "NPX",
      badge: "skills.sh",
      status: "Skills installer",
      detail: "Use the skills.sh NPX installer to add Aspire skills directly from this GitHub repository.",
      command: "npx skills add microsoft/aspire-skills",
      language: "bash",
      title: "skills.sh NPX",
      icon: "npm",
      notes: [
        "Installs Aspire guidance through the Skills-compatible installer path.",
        "Use this when your agent host supports skills.sh-managed skill locations."
      ]
    }
  ];
}

function cleanDescription(description: string): string {
  return description
    .replace(/\*\*[^*]+\*\*\s*[-\u2014]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function stripMarkdown(value: string): string {
  return value
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .trim();
}

function firstParagraph(markdown: string): string {
  return markdown
    .split(/\n{2,}/)
    .map((block) => block.replace(/^#+\s+/gm, "").replace(/^>\s?/gm, "").trim())
    .find((block) => block.length > 0) ?? "";
}

function toTitleCase(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
