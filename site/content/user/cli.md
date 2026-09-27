The command line is the complete interface to [Construct](@user-guide/construct/): one command per job, the same answer every time, and a line at the end saying what ran. It has no separate name — the command is just `construct`. Everything the [Cockpit](@user-guide/cockpit/) can do starts here.

## Get it on your path

```bash
git clone https://github.com/thenewurbankid-web/construct.git && cd construct && npm install && npm link
construct                 # prints the full usage text
construct doctor          # checks your Node, npm and the tools it needs
```

Run `construct repl` for an interactive shell with built-in help (`help`, `help <topic>`), so you do not retype the command name or `--dir` on every line.

## The commands, grouped

| Group | Use it to |
|---|---|
| `construct create ...` | Scaffold a feature, one file, or a whole slice. |
| `construct refactor ...` | Move or rename within your own rules, mechanically. |
| `construct research ...` | Read-only: summarise a feature, explain its workflows, compute what a change touches, check your environment. |
| `construct import ...` | Bring an existing, non-Construct file or route across. |
| `construct validate` | Check the project against its rules. |
| `construct review <base> <head>` | Read-only health check between two git refs. |
| `construct generate tests <feature>` / `construct test run <feature>` | Generate one locked test per route through a workflow, and run them. |
| `construct template list \| show \| instantiate` | Named, reusable, parameterised plans. None are bundled: point it at your own directory. |
| `construct pipeline run` | Read a job description as JSON on standard input and write one back out. |

Every command takes `--dir <path>`, so you can run it from anywhere: it finds the nearest `architecture.yml` above that path and never touches anything outside that project. The full list of commands and flags is in the [CLI reference](@developers/cli-reference/), generated from the command's own usage text so it cannot drift.

A package built on Construct can add its own `construct <name>` command without touching Construct's source: it declares a `construct.commands` field in its own `package.json` pointing at a small module of command definitions, and `construct` picks it up once the package is installed alongside it. See `docs/CLI-COMMAND-REGISTRY.md` in the repository for the contract.

## What you can rely on in a script

- **Exit codes.** `0` success (warnings do not fail a run), `1` one or more errors, `2` a usage error, `3` an internal error, including a rejected model reply.
- **Machine-readable output.** `--format json` on `validate`, `research summarize`, `research impact` and `review` prints pure JSON you can pipe.
- **A record of every run.** Each `create`, `refactor`, `research` and `import` ends with one line, `[tool: ...] [llm: ...]`, saying what was done and how many model calls were made. Without `--llm` that number is zero.

## Where it fits

The command line and the Cockpit call the same functions, so a change made by either is the same change. Use the terminal for scripts, CI and repeatable work; use the Cockpit when you would rather see a diagram, a diff or a plan before approving it.

## Examples

[Scaffold, then catch a rule break](@user-guide/examples/cli-scaffold-and-validate/), [what a change touches and branch review](@user-guide/examples/cli-impact-and-review/), and [every route through a flow, tested](@user-guide/examples/cli-flows-and-tests/).
