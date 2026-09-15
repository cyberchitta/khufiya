# CLAUDE.md — khufiya

Produces the data series behind the `private-canary` page on
www.cyberchitta.cc (sibling repo `../www.cyberchitta.cc`). The site consumes
the output; it does not fetch from chains itself once a series moves here.

Read `_notes/intent.md` before changing what a series measures or where it
comes from.

## Layout

- `scripts/fetch-privacy-coin-stats.js` — fetches every series, writes into the
  site repo. Runbook: the `private-canary-refresh` skill (`.claude/skills/`).
- `data/` — hand-maintained series (Visa/UPI).
- `baselines/` — reference results an on-chain reader must reproduce.

## Working notes

`_notes/` → `working-notes/khufiya` (gitignored symlink). **AI-maintained, not
read-only:** sessions update state and write debriefs there as part of the work.
