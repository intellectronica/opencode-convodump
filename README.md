# opencode-convodump

An OpenCode plugin that exports each conversation session to a readable
Markdown transcript.

## What it does

- Listens for session idle events.
- Fetches the latest session snapshot (session metadata + messages).
- Writes/updates transcript files at:
  `convos/YYYY-MM-DD-HH-mm-ss-<session-id>.md`
- Uses a compact frontmatter and conversation-first body format.

## Install

Install via npm by adding the package name to `plugin` in your OpenCode config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-convodump"]
}
```
