# JavaScript and TypeScript app patterns

Use this reference when wiring JavaScript/TypeScript services into the AppHost or configuring TypeScript AppHost dependencies (Step 5 and Step 6).

## Choosing the right JavaScript resource type

The `Aspire.Hosting.JavaScript` package provides three resource types. Pick the right one:

| Signal | Use | Example |
|--------|-----|---------|
| Vite app (has `vite.config.*`) | `AddViteApp(name, dir)` | Frontend SPA, Vite + React/Vue/Svelte |
| App runs via package.json script only | `AddJavaScriptApp(name, dir, { runScriptName })` | CRA app, Next.js, monorepo root scripts |
| App has a specific Node entry file (`.js`/`.ts`) and uses a dev script like `ts-node-dev` | `AddNodeApp(name, dir, "entry.js")` + `.WithRunScript("start:dev")` | Express/Fastify API, Socket.IO server |

**Key distinctions:**
- `AddNodeApp` is for apps that run a **specific file** with Node (e.g., an Express server at `src/index.ts`). Use `.WithRunScript("start:dev")` to override the dev-time command (e.g., `ts-node-dev`).
- `AddJavaScriptApp` runs a **package.json script** — simpler, good when the script handles everything.
- `AddViteApp` is `AddJavaScriptApp` with Vite-specific defaults (auto-HTTPS config augmentation, `dev` as default script).

## JavaScript dev scripts

Use `.WithRunScript()` to control which package.json script runs during development:

```typescript
// Express API with TypeScript: uses ts-node-dev for hot reload in dev
const api = builder
    .addNodeApp("api", "./api", "src/index.ts")
    .withRunScript("start:dev")                      // runs "yarn start:dev" (ts-node-dev)
    .withYarn()
    .withHttpEndpoint({ env: "PORT" });

// Vite frontend: default "dev" script is fine, just add yarn
const web = builder
    .addViteApp("web", "./frontend")
    .withYarn();
```

## Framework-specific port binding

Not all frameworks read ports from env vars the same way:

| Framework | Port mechanism | AppHost pattern |
|-----------|---------------|-----------------|
| Express/Fastify | `process.env.PORT` | `.withHttpEndpoint({ env: "PORT" })` |
| Vite | `--port` CLI arg or `server.port` in config | `.withHttpEndpoint({ env: "PORT" })` — Aspire's Vite integration handles this automatically |
| Next.js | `PORT` env or `--port` | `.withHttpEndpoint({ env: "PORT" })` |
| CRA | `PORT` env | `.withHttpEndpoint({ env: "PORT" })` |

When the framework supports reading the port from an env var or Aspire already handles it, **prefer that over pinning a fixed port**. Managed ports make repeated local runs more reliable and work better when multiple services or multiple Aspire apps are running.

**Suppress auto-browser-open:** Many dev servers (Vite, CRA, Next.js) auto-open a browser on start. Add `.withEnvironment("BROWSER", "none")` to prevent this in Aspire-managed apps. Vite also respects `server.open: false` in its config.

## Yarn/pnpm workspace monorepos

In monorepos that use **yarn workspaces** or **pnpm workspaces**, all workspace packages share a single root-level `node_modules/` directory (hoisted or symlinked). This creates two specific problems with `.withYarn()` / `.withPnpm()`:

1. **Concurrent install conflicts (Windows)**: `.withYarn()` runs `yarn install` before each resource starts. When multiple resources start concurrently, each triggers a root-level `yarn install` that tries to write to the shared `node_modules/`. On Windows, this causes `EPERM: operation not permitted` errors when one resource's running process (e.g., `esbuild.exe`) holds a file lock while another `yarn install` tries to overwrite it.

2. **Redundant installs**: In a properly set up workspace, `yarn` at the root installs everything for all workspaces. Running `yarn install` per-resource is redundant and slow.

**The fix: don't use `.withYarn()` on individual workspace resources.** Instead, ensure dependencies are installed once at the root before starting:

```typescript
// ❌ WRONG for workspace monorepos — concurrent installs cause file locking errors
const app = builder.addViteApp("app", "./packages/frontend")
    .withYarn();  // triggers yarn install at startup → EPERM on Windows

const api = builder.addNodeApp("api", "./packages/api", "src/index.ts")
    .withYarn();  // second concurrent yarn install → file lock conflict

// ✅ CORRECT for workspace monorepos — deps already installed at root
const app = builder.addViteApp("app", "./packages/frontend");

const api = builder.addNodeApp("api", "./packages/api", "src/index.ts")
    .withRunScript("start:dev");
```

Tell the user: *"This is a yarn workspace monorepo — I'll skip `.withYarn()` on individual resources since dependencies are shared at the root. Make sure to run `yarn` at the root before `aspire start`."*

**This only applies to workspace monorepos with shared `node_modules`.** For standalone apps or apps with independent `node_modules` directories, `.withYarn()` / `.withPnpm()` is correct and should be used — it ensures deps are installed before the resource starts.

## Shared library packages in monorepos

Many brownfield JS/TS monorepos have a shared package (`packages/shared`, `libs/common`, etc.)
compiled to `dist/` and consumed by sibling services/apps via npm-workspaces, yarn workspaces,
or pnpm workspaces. Vite, Express, and other consumers fail at first request if `dist/` doesn't
exist when they start.

Model the build as an `addJavaScriptApp` resource that runs the library's `build` script, and
have every consumer `.waitForCompletion(shared)`:

> **⚠️ The single most common failure here is a `tsc --incremental` build that exits 0 without
> emitting `dist/`** — the consumers then fail at first request even though the build "succeeded".
> Always pair the shared-build resource with a clean `prebuild` step (see the pitfall below).

```ts
const shared = builder.addJavaScriptApp("shared-build", "../packages/shared", { runScriptName: "build" });

const api = builder.addJavaScriptApp("api", "../services/api", { runScriptName: "dev" })
    .withHttpEndpoint({ name: "http", env: "PORT" })
    .waitForCompletion(shared);

builder.addViteApp("web", "../apps/web")
    .withReference(api)
    .waitForCompletion(shared)
    .waitFor(api);
```

**`waitForCompletion` vs `waitFor`**: use `waitForCompletion(shared)` because the build is a
one-shot process that exits when done. `waitFor` blocks until a resource is *healthy* and would
never resolve for a process that exits.

### ⚠️ tsc incremental emit pitfall

If the shared package uses `tsc --incremental` (the default for `composite: true` projects), the
build can succeed (exit 0) without emitting anything, leaving `dist/` empty even though
`aspire wait shared-build` returns healthy. The symptom is consumers failing at request time:

```
Failed to resolve entry for package "@yourorg/shared".
```

The fix is to wipe the incremental cache before each build:

```json
{
  "scripts": {
    "prebuild": "node -e \"const fs=require('node:fs');fs.rmSync('dist',{recursive:true,force:true});fs.rmSync('tsconfig.tsbuildinfo',{force:true})\"",
    "build": "tsc -p tsconfig.json"
  }
}
```

npm/yarn/pnpm all run `prebuild` automatically before `build`. This makes the shared-build
resource self-healing whether it's invoked by Aspire, by CI, or by the user's existing
`npm run build:shared`.

Alternative: use `tsc --build --clean && tsc --build` in the `build` script directly. Slower but
doesn't require a separate `prebuild` step.

### When NOT to use this pattern

If the shared package is published to a registry (private or public npm) and consumers depend on
the published version, no AppHost build step is needed — `npm install` handles it. The pattern
above is only for **source-linked** shared packages (npm-workspaces, yarn workspaces, pnpm
workspaces, or `npm link`).

## TypeScript AppHost dependency configuration (Step 6)

### package.json

If one exists at the root, augment it (do not overwrite). Add/merge these scripts that delegate to the Aspire CLI:

```json
{
  "type": "module",
  "scripts": {
    "dev": "aspire run",
    "build": "tsc",
    "watch": "tsc --watch"
  }
}
```

If no root `package.json` exists, create a minimal one matching the canonical Aspire template:

```json
{
  "name": "<repo-name>",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "aspire run",
    "build": "tsc",
    "watch": "tsc --watch"
  },
  "engines": {
    "node": "^20.19.0 || ^22.13.0 || >=24"
  }
}
```

**Important**: Scripts should point to `aspire run`/`aspire start` — the Aspire CLI handles TypeScript compilation internally. Do not use `npx tsc && node apphost.js` patterns.

Never overwrite existing `scripts`, `dependencies`, or `devDependencies` — merge only. Do not manually add Aspire SDK packages — `aspire restore` handles those.

Run `aspire restore` to generate the `.aspire/modules/` directory with TypeScript SDK bindings, then install dependencies with the repo's package manager (`npm install`, `pnpm install`, or `yarn`).

### tsconfig.json

Augment if it exists:

- Ensure `".aspire/modules/**/*.ts"` and `"apphost.ts"` are in `include`
- Ensure `"module"` is `"nodenext"` or `"node16"` (ESM required)
- Ensure `"moduleResolution"` matches

If no `tsconfig.json` exists and `aspire restore` didn't create one, create a minimal one:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "esModuleInterop": true,
    "strict": true,
    "outDir": "./dist",
    "rootDir": "."
  },
  "include": ["apphost.ts", ".aspire/modules/**/*.ts"]
}
```

### ESLint

Only augment if config already exists. If it uses `parserOptions.project` or `parserOptions.projectService`, ensure the AppHost tsconfig is discoverable. Do not create ESLint configuration from scratch.
