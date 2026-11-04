# Strowger

Read `docs/PLAN.md` (what and why) and `docs/HANDOFF.md` (how it is wired,
what will trip you) before changing anything.

- pnpm monorepo. `pnpm typecheck && pnpm lint && pnpm test && pnpm build`
  must pass before a push; CI runs the same.
- Every business table carries `tenantId`. Compliance rules are data in
  `packages/shared/src/compliance/`, never scattered conditionals; a rule
  change comes with a test.
- Next.js 16 in `apps/web`: read `node_modules/next/dist/docs/` before using
  an API you remember from an older version.
- Record decisions in `docs/HANDOFF.md` in the same commit that makes them.
