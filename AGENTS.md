# AGENTS.md

Guide for AI coding agents working on this repo.

## What this is

`reply-sheet` is a Claude Code plugin made of a hooks module (a "mod"). It adds a **Reply sheet** row above the prompt. The row lets the user answer Claude's last reply item by item, either in a pane beside the chat or in `response.md` in VS Code. Haiku builds that file through `$.model.complete`, and only answered items go back to Claude.

## Layout

| Path | Holds |
|---|---|
| `.claude-plugin/plugin.json` | Manifest: name, version, `userConfig` (the `icons` setting) |
| `.claude-plugin/marketplace.json` | Makes the repo installable with `/plugin install`. Not an official marketplace listing |
| `hooks/hooks.json` | Points at `./register.tsx` |
| `hooks/register.tsx` | Hooks, band buttons, pane, commands, file opening, scratchpad lookup |
| `hooks/draft.ts` | Pure logic: Haiku's rules (`RULES`), `parseDraft`, `serializeDraft`, `compactReply`, `fieldRows`, `missingLines` |
| `types/index.d.ts` | State contract (`PluginState['reply-sheet']`) and shared types |
| `tests/` | `draft.test.ts` (pure logic), `icons.test.tsx` (band UI), `fixtures.ts` (real Haiku output) |
| `.github/` | CI, release workflow and the `setup-claude` action that pins the Claude Code version |

`.claude-plugin/types/` is written by the engine when it loads the mod and is git-ignored. `tsconfig.json` extends it.

## Commands

```sh
claude plugin validate --strict .   # manifest, marketplace, hooks, state contract
claude plugin test .                # all tests in tests/
```

Run both before every commit. CI (`.github/workflows/ci.yml`) runs the same two commands on every PR and push to `main`, and neither needs a Claude login.

## Running from a local clone

Add the clone to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`, then start a new session:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/claude-code-reply-sheet"
  }
}
```

Or for one session only: `claude --plugin-dir /path/to/claude-code-reply-sheet`.

Don't load the installed plugin and a local clone at once, or the buttons show twice. Uninstall one first (`claude plugin uninstall reply-sheet`).

## Rules

- Keep pure logic in `hooks/draft.ts` and test it there. `register.tsx` is for code that needs `$`.
- If you change Haiku's rules or the draft format, update the fixtures in `tests/fixtures.ts` and keep the `missingLines` check passing.
- The repo must stay free of employer, client or internal names. Fixtures are real output, so check them before adding.
- Must work on macOS, Windows and Linux, and when VS Code or a Nerd Font is missing. Every external open goes through `openPaths`, which has fallbacks.
- Settings go in `userConfig` in `plugin.json`, not env vars.
- Code comments: one or two lines, and only for the non-obvious "why".
- Conventional Commits (`feat:`, `fix:`, `docs:`, `ci:`, `test:`). Work on a branch and open a PR; don't push to `main`.

## Engine API gotchas

These were found the hard way. The full API is in `.claude-plugin/types/claude-code/index.d.ts` once the mod has loaded.

- `$.env.get('NAME')` only takes a string literal, not a variable.
- `$.fs.list` marks folders with kind `'dir'`, not `'directory'`.
- `$.ui.close` takes `{ id }`, not a bare string.
- Changing a stored atom's shape needs `Shaped<T>` in the contract and a new `{ shape: '...' }` tag on the atom (now `form-2`). Otherwise old stored values break the new code.
- The contract file must export at least one type; a bare `export {}` is refused.
- `Input` empties itself on Enter. The pane bumps a `rev` counter in the element's `key` so it redraws with the saved text.
- Box height comes from `rows`, set by `fieldRows`, so text grows downward instead of scrolling.
- A button `hotkey` only fires while the pane has focus, and Esc moves focus back to the prompt. There is no Ctrl or Cmd shortcut.
- The `AbovePrompt` band is shared with other plugins: always keep `await next(e)` (`theirs`) in the returned tree.
- `prompt.compose` hooks can be bypassed by security plugins above this one. Don't rely on them.
- The scratchpad path is not in the API. `findScratchpad` searches the temp folders for `claude*/<project>/<session id>/scratchpad`, because long project names are hashed.
- In tests, `FoundElement` has `.text` and `.props`, not `.label`. Set `userConfig` values with `test(name, { options }, body)`.

## Releasing

1. Bump `version` in `.claude-plugin/plugin.json` in a PR, and merge it.
2. On an up-to-date `main`, run `claude plugin tag . --push`. It checks that `plugin.json` and `marketplace.json` agree, then creates and pushes `reply-sheet--v<version>`.
3. `.github/workflows/release.yml` checks the tag against `plugin.json`, validates, tests and creates the GitHub release with generated notes and a `reply-sheet-<version>.plugin` file. The file holds only `plugin.json`, `hooks/`, `types/`, `LICENSE` and `README.md`.

To move to a newer Claude Code, bump `version` in `.github/actions/setup-claude/action.yml` and make sure CI passes.
