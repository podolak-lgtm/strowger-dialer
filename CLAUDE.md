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
- One agent, one call control, ever (owner's hard rule): never more than one
  line/call control per agent. A second window, tab or device is told "you
  already have a call screen open elsewhere"; it never silently takes over
  or doubles up. (HANDOFF "Call path hardening, engine".)
- Page layout: a page with three or more independent parts gets tabs: one
  row only (the section's bar in `packages/shared/src/nav.ts`; each tab its
  own URL), no long stacks of cards. A settings form spread over tabs gets a
  single Save with per-tab unsaved dots, as on the campaign page. A page
  whose job is one table stays one page. (HANDOFF "Navigation".)
