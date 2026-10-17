# Obsidian Worklog Migrate

Move unfinished checkbox tasks from earlier entries in the current month's work log to today while preserving completed tasks and regular notes in their original entries. Your Markdown files remain the single source of truth; the plugin uses no database or external services.

## Installation

1. Run `npm install && npm run build` in this directory.
2. Copy `manifest.json` and the generated `main.js` to `.obsidian/plugins/worklog-migrate/` in your vault.
3. Enable **Worklog Migrate** under **Settings → Community plugins** in Obsidian.
4. In the plugin settings, enter the directory that contains your work logs, such as `Worklog`. The directory must already exist. The plugin only accesses the current month's `YYYYMM.md` file in this directory.
5. Run **Migrate TODOs** from the command palette. The command is shown as **迁移待办** when Obsidian is set to Chinese. You can also assign it a hotkey. The command ID remains unchanged, so existing hotkeys continue to work. Reload the plugin after changing the Obsidian interface language to update the command name.

## Behavior

- The plugin uses the local date of the device running Obsidian. Monthly files are named `YYYYMM.md`, and today's heading is written as `# MM.DD` (for example, `# 10.09` in `202610.md`). Today's section is placed before the other dated sections. If the current month's file does not exist, the plugin creates it. The filename supplies the year and month used to sort and deduplicate dates within the file.
- Only dated sections earlier than today in the current month's file are processed. Files from previous months are never read or modified, and historical dates do not need to be consecutive.
- Standard unfinished checkbox tasks such as `- [ ]` are moved to the same complete heading path under today's section. Completed tasks such as `- [x]` remain under their historical dates. Task dates, priorities, and other task text are preserved exactly.
- Nested task trees are split according to completion state. If a parent task is not moved, its unfinished child tasks are promoted to the nearest movable parent level. Indented non-checkbox lines belonging to a task move with that task.
- Task indentation may use spaces, tabs, or both. Lines whose nesting level does not change retain their original indentation. Promoted lines are recalculated using Markdown four-column tab stops and written with spaces.
- Adjacent TODOs remain adjacent after migration. Blank lines between tasks are preserved when they exist in the source.
- Regular Markdown content in heading branches that contain unfinished tasks is copied to today's section. Identical content blocks are not copied again, and existing tasks or notes under today's section are never overwritten.
- By default, the plugin removes project headings left empty by migration. When the contents of a historical level-two heading have been copied to today and no tasks beneath it need to remain, the heading and its original regular content are removed. Completed tasks and independent note branches that were not copied remain in the historical section, and date headings are always retained. You can disable regular-content copying or project cleanup, and you can enable deferral records or a preview before writing.

## Data safety and known limitations

The plugin parses the current month's file and prepares the complete migration in memory before writing. Immediately before a write, it checks whether another operation changed the file. If the file changed in the meantime, the migration is aborted and you are asked to try again.

The parser preserves the original text of each line and does not reorder unrelated content. It recognizes ATX headings, fenced code blocks, HTML comments, and standard checkbox lists. Existing `# YYYY-MM-DD` headings are supported, although newly created headings use `# MM.DD`.

If a historical date section contains an incompatible structure—such as duplicate date headings, an invalid date, or a task whose parent cannot be determined safely—the plugin preserves that section unchanged, skips it, and continues processing other valid dates. An unclosed code fence or HTML comment makes date boundaries unreliable, so the entire monthly file is skipped. Reasons for skipped content appear in the preview and are written to the Obsidian developer console.

Regular-content deduplication compares complete text blocks. If you manually edit a block that was previously copied to today and later add another unfinished task to the same historical branch, the original block may be copied again. Enable the preview for your first migration, and keep a vault backup or file history.

## Development

```sh
npm install
npm run lint
npm test
npm run typecheck
npm run build
```

The migration planner is implemented in `src/core.ts`. It does not depend on Obsidian and can be tested independently. Obsidian commands, settings, and monthly-file writes are implemented in `src/main.ts`.

Run `./pack-src.sh` to create `src.zip` in the project root. The archive contains the source code, tests, build configuration, plugin metadata, license, and this README. It excludes dependencies and the generated `main.js`.

## License

This project is licensed under the [MIT License](./LICENSE).
