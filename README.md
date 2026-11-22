# makefun-hidden-spec-cli-01-run-20261122

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Tiiashtf/makefun-hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Tiiashtf/makefun-hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend — one patch tool for every AI edit format. It applies unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks, V4A patches and JSON tool-call edits to a tree of text files, finding the lines each edit names at the first of three matching tiers, and writes every change or none.

## Run it

```sh
node main.ts [options] [PATCH]
```

Options: `--format=unified|search-replace|v4a|json|auto` (default `auto`), `--check` (dry run: same output and exit code, nothing written), `--strict` (exact line matching only). `PATCH` is a patch file, or `-`/absent to read from standard input. See `SPEC.md` for the full contract.

## The files

- `main.ts`: the CLI, Node 22 and its standard library alone.
- `runner.ts`: the kit's trial runner (kept as shipped); `main.ts` hands a trial over to it when `MAKEFUN_ENV_URL` is set.
- `check.ts`: runs the kit's public practice set against `main.ts` (`node check.ts ../program/generator/practice.json`).
- `SPEC.md`: the specification this tool implements.

---

<sub>Entered on [make.fun](https://make.fun/?ref=635rx196&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
