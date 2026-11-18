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
   never fork it. Plans and the status list (`docs/status.md`) are updated in
   the same commit as the change they describe.

## Implementation workflow

- Multi-file/non-trivial work: delegate via `subagent`; parent
  plans/dispatches/merges and triages disagreements (`SKILL.md`/Gates
  wins). Single-file trivial/docs edits in-session.
- Feature/behavior changes, plus contract-adjacent refactors (IPC,
  storage, `fs`/CSP, serde), after `Gates` pass: one parallel review
  round with up to five `general` reviewers (no Next.js reviewers —
  this is a Tauri project). Prompt each with the repo stack (Tauri v2,
  TypeScript/Vite `src/`, Rust `src-tauri/`, `SKILL.md`, Gates) acting
  as: UX/UI designer (dialogs, focus, 44px targets, status
  announcements), frontend developer, Rust/Tauri backend developer,
  software architect (contract/scope, plan coherence), end-user
  (landing/scope/print/paper path). Parent may trim roles to the change
  surface with a logged reason. Skip for docs-only/trivial.
- Apply only `SKILL.md`/Gates-breaking must-fix in the same commit; log
  waived items. Stop after 1 round; 2nd round only if a fix broke
  `Gates`. Note as `Reviewed YYYY-MM-DD: <agents>, <fixes
  applied/waived>` under the spec's `### Shipped notes`.

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
