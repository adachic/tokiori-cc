# tokiori-cc

Reflect your **Claude Code** work sessions into your [tokiori](https://tokiori-app.com) timeline — automatically, with category detection.

You code with Claude Code as usual; the time shows up on your tokiori timeline as completed sessions. No manual start/stop.

## What it sends — and what it doesn't

This tool is open source precisely so you can verify this yourself. It sends only minimal metadata to **your own** tokiori account:

**Sent**
- Session start / end time
- Category (auto-detected from the project you're working in)
- Title (a one-line summary of your first instruction)

**Never sent**
- Your source code or file contents
- Keystrokes or terminal output
- Your conversations with Claude

The exact payload is built in [`src/hook.js`](src/hook.js) (`postManualUpdate`) and the category/title logic in [`src/categorize.js`](src/categorize.js). Read them — that's all that leaves your machine.

## Trust & safety

- **Open source** — every byte that's sent is visible in this repo.
- **Same login as the app** — `tokiori-cc login` uses the same Google sign-in as the tokiori dashboard. Your token is stored only in `~/.tokiori/` on your machine and never leaves it.
- **Stop anytime** — `tokiori-cc off`, or preview before sending with `tokiori-cc hook --dry-run`.
- **Inspect anytime** — `tokiori-cc status` shows exactly what's active.

## Install

```bash
npm install -g tokiori-cc
tokiori-cc init     # registers the integration with Claude Code (once)
tokiori-cc login    # sign in with Google in your browser
```

That's it. Use Claude Code normally — your work appears on the timeline.

## How it works

`init` registers a [Claude Code Stop hook](https://docs.claude.com/en/docs/claude-code/hooks) that runs `tokiori-cc hook` when a session's response finishes. The hook:

1. reads the session's start time and first instruction from the local transcript,
2. detects the category from the working directory,
3. posts a completed session to your tokiori timeline.

One Claude Code session becomes one timeline block that grows as you work (no duplicates). The hook never blocks Claude Code: on any error it records to `~/.tokiori/error.log` and exits cleanly.

## Commands

| Command | Description |
|---|---|
| `tokiori-cc init` | Install the integration (idempotent) |
| `tokiori-cc login` | Sign in with Google |
| `tokiori-cc status` | Show status and pending uncategorized count |
| `tokiori-cc categorize` | Interactively categorize unknown projects (then automatic) |
| `tokiori-cc on` / `off` | Enable / disable auto-recording |
| `tokiori-cc doctor` | Re-check the hook registration |

## Category detection

Projects are mapped to your categories automatically. The first time a project can't be matched, it's recorded as uncategorized and queued. Run `tokiori-cc categorize` to assign it once — it's automatic from then on. Optionally set an `anthropicApiKey` in `~/.tokiori/config.json` to auto-classify unknown projects.

## Privacy

tokiori is privacy-first. This integration follows the same principle: it records only how much time you spent and on what — never the content of your work.

## License

MIT © Norio Studio
