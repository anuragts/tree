# Tree Coding Agent

Tree is an open source coding agent designed to be agnostic and support multiframeworks and swarn of agents.

## Features

- Interactive terminal UI for coding-agent sessions.
- Adapter-neutral event model shared by the UI and session store.
- Agno AgentOS, Claude, and Codex adapter packages.

## Requirements

- Bun 1.3.12 or newer for development.
- Node.js 20 or newer for built ESM output.
- Optional local CLIs or services for the adapters you use:
	- Agno AgentOS service or sidecar.
	- Claude CLI or SDK-compatible local setup.
	- Codex CLI for Codex adapter modes.

## Setup

```sh
bun install
cp tree.config.example.toml tree.config.toml
```

Edit `tree.config.toml` if you want to change the default adapter, workspace directory, session location, or adapter-specific settings.

Tree loads environment variables from `.env` in the directory where it is started. Existing shell variables take precedence, so you can also export keys before launching Tree:

```sh
export OPENAI_API_KEY=...
export ANTHROPIC_API_KEY=...
```

Inside the TUI, run `/set`, choose OpenAI or Anthropic, and paste the key. Tree writes the key to the workspace `.env` file and ensures `.gitignore` excludes local env files.

To attach a screenshot or copied image to your next message, press `Ctrl+V` in the TUI or run `/image`. Tree saves the clipboard image under `.tree/attachments` and sends it as an image file to Agno AgentOS.

If you use the bundled Agno sidecar from a custom checkout, set these in `.env` or your shell:

- `TREE_AGNO_REPO` to the local Agno repository path.
- `TREE_AGNO_PYTHON` to the Python interpreter for that environment.

## Usage

Start the interactive TUI:

```sh
bun run dev
```

Run with a specific adapter:

```sh
bun run dev -- --adapter codex
```

Run once and print the output:

```sh
bun run dev -- --print "summarize this repository"
```

List configured agents:

```sh
bun run dev -- --list-agents
```

List local sessions:

```sh
bun run dev -- --sessions
```

Export a saved session:

```sh
bun run dev -- --export <session-id-or-file>
```

## Scripts

```sh
bun run dev      # Start the CLI from source
bun run build    # Build all workspace packages
bun run check    # Type-check all workspace packages
bun run test     # Run tests
bun run lint     # Run Biome checks
```

## Workspace

```text
apps/tree-cli/        CLI entrypoint and sidecar startup
packages/core/        Config, runtime host, event types, session store
packages/adapters/    Agno, Claude, and Codex adapters
packages/tui/         Terminal UI
agents/               Optional local Agno coding-agent sidecar
```

## Configuration

The default config file is `tree.config.toml`. A safe template is tracked as `tree.config.example.toml`; the real config file is ignored so local paths, ports, and tokens stay out of git.

## Development

Run the focused checks before committing:

```sh
bun run check
bun run test
bun run lint
```
