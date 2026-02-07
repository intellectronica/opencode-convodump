# opencode-convodump

An OpenCode plugin that exports each conversation session to a readable
Markdown transcript.

## What it does

- Listens for session idle events.
- Fetches the latest session snapshot (session metadata + messages).
- Writes/updates transcript files at:
  `convos/YYYY-MM-DD-HH-mm-ss-<session-id>.md`
- Uses a compact frontmatter and conversation-first body format.

## Install from npm

Add the package name to `plugin` in your OpenCode config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-convodump"]
}
```

OpenCode installs npm plugins automatically with Bun.

## Local file usage (without npm)

Use the plugin file directly:

- Project: `.opencode/plugins/convodump.ts`
- Global: `~/.config/opencode/plugins/convodump.ts`

## Release process

Publishing to npm is automated from GitHub Releases using
`.github/workflows/publish-npm.yml`.

1. Bump `version` in `package.json`.
2. Commit and push the version change.
3. Create a GitHub Release with tag `v<version>` (for example `v0.0.1`).
4. The workflow publishes that version to npm.

You can also run the same workflow manually from GitHub Actions using
`workflow_dispatch` (optionally passing `release_tag`, defaulting to
`v<package.json version>`).

### One-time setup required

1. Create an npm automation token for the account that will publish this
   package.
2. Add the token as a GitHub Actions secret named `NPM_TOKEN`.
3. Ensure the npm account tied to `NPM_TOKEN` has publish rights to
   `opencode-convodump`.
