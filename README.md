# opencode-convodump

An OpenCode plugin that exports each conversation session to a readable
Markdown transcript.

## What it does

- Listens for session idle events.
- Fetches the latest session snapshot (session metadata + messages).
- Writes/updates a transcript file at:
  `convos/YYYY-MM-DD-HH-mm-ss-<session-id>.md`
- Uses a compact frontmatter and conversation-first body format.

## Repository layout

- Plugin source: `.opencode/plugins/convodump.ts`
- OpenCode plugin dependency: `.opencode/package.json`
- Generated transcripts: `convos/` (gitignored)

## How to use

Install the plugin either per project or globally.

### Per-project install

1. In your target repo, create `.opencode/plugins/`.
2. Copy this file to `.opencode/plugins/convodump.ts`.
3. Ensure `.opencode/package.json` includes:

```json
{
  "dependencies": {
    "@opencode-ai/plugin": "1.1.53"
  }
}
```

4. Run OpenCode in that repo (`opencode run ...`, `opencode`, or
   `opencode serve`).

This enables transcript export only for that project.

### Global install

1. Create `~/.config/opencode/plugins/` if needed.
2. Copy this file to `~/.config/opencode/plugins/convodump.ts`.
3. Ensure `~/.config/opencode/package.json` includes:

```json
{
  "dependencies": {
    "@opencode-ai/plugin": "1.1.53"
  }
}
```

4. Run OpenCode in any project.

This enables transcript export for all projects.

Note: avoid installing the same plugin both globally and per-project,
otherwise both copies will load.

## Notes

- Exports are atomic (temp file + rename).
- Duplicate idle triggers are deduplicated.
- Tool calls are rendered as a single JSON block with top-level
  `tool`, `input`, and `output`.

## License

CC0 1.0 Universal. See `LICENSE`.
