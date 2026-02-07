# opencode-convodump

An OpenCode plugin that exports each conversation session to a readable
Markdown transcript.

## What it does

- Listens for session idle events.
- Fetches the latest session snapshot (session metadata + messages).
- Writes/updates a transcript file at:
  `convos/YYYY-MM-DD-HH-mm-ss-<session-id>.md`
- Uses a compact frontmatter and conversation-first body format.

## How to use

Copy [`convodump.ts`](.opencode/plugins/convodump.ts) into an OpenCode
plugins directory:

- Project: `.opencode/plugins/convodump.ts`
- Global: `~/.config/opencode/plugins/convodump.ts`
