# CarPal: Claude Code working rules

- Delegate repo searches and test runs to the project's Haiku subagents to keep the main context small: `search` maps the repo, `grep` finds call sites, `test` runs tests/lint, `audit` reviews changes before commit. Use these project agents, not the user-level `code-reader`. The main session still reads, directly, any file it is about to edit (required by Edit), and may do a single lookup when the exact path is already known.
- Audit before every commit: refresh the diff snapshot, run `audit`, and report or fix its findings before committing. Never audit a stale snapshot; refresh it in the same turn, with the Bash tool (Git Bash), not PowerShell:
  `mkdir -p .claude/audit && f=.claude/audit/pending.diff && { git status --porcelain --untracked-files=all; echo; git diff HEAD; } > "$f.body" && { echo "# $(date -Iseconds) HEAD $(git rev-parse --short HEAD) LINES $(( $(wc -l < "$f.body") + 1 ))"; cat "$f.body"; } > "$f" && rm "$f.body"`
