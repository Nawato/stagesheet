# StageSheet — agent notes

Entry point for coding agents working in this repo. The data contract lives
in `SKILL.md`; feature specs and the development plan live in `docs/plans/`.

## Before changing code

1. Read `SKILL.md` before editing models, storage, IPC, or the printable
   sheet. Its hard rules are non-negotiable: black-on-white A4 output,
   Rust-computed durations, storage under `<app_data_dir>/stagesheet/` with
   the frontend `fs` capability scoped to `$APPDATA/stagesheet/**`, every
   Tauri command `async` returning `Result<T, AppError>`, logos via `<img>`
   only.
2. Feature specs in `docs/plans/upcoming-features.md` extend the contract;
   never fork it. Plans and the README status lists are updated in the same
   commit as the change they describe.

## Gates

- `npm run build` (TypeScript strict + Vite) must pass.
- `cargo test` in `src-tauri` (or `npm run test:rust` from the root) must
  pass; the `tauri` crate needs the `webkit2gtk-4.1` system libraries to
  compile even for pure model tests.
- Never widen the frontend `fs` capability or the CSP for a feature; use
  dialog-scoped access and export-only data flows instead.

## Commits

- Conventional Commits with a scope: `feat(sheet): …`, `fix(export): …`,
  `docs(plans): …`, `chore(ci): …`. One logical change per commit; stage
  deliberately and confirm `git diff --staged` before committing.
