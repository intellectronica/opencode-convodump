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

From this repo, just run OpenCode normally (for example `opencode run ...`
or `opencode serve`). The plugin exports transcripts automatically after
session idle events.

To reuse in another repo:

1. Copy `.opencode/plugins/convodump.ts`.
2. Add `@opencode-ai/plugin` to `.opencode/package.json`.
3. Run OpenCode from that repo root.

## Notes

- Exports are atomic (temp file + rename).
- Duplicate idle triggers are deduplicated.
- Tool calls are rendered as a single JSON block with top-level
  `tool`, `input`, and `output`.

## License

CC0 1.0 Universal. See `LICENSE`.
