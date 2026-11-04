# Strowger

An outbound contact center: ratio and preview dialer with texting, built for
human agents, TCPA compliance designed in. Runs standalone, and plugs into
Crossbar when a customer has it.

Start with [docs/PLAN.md](docs/PLAN.md). Operating notes are in
[docs/HANDOFF.md](docs/HANDOFF.md).

## Layout

```
apps/web          Next.js 16: admin, supervisor board, agent screen (Clerk auth)
apps/engine       Node/Fastify: pacing loop, jambonz webhooks, Socket.IO hub, workers
packages/db       Prisma schema + client (Postgres)
packages/shared   Phone utils, compliance rules (state matrix + window evaluator), env
```

## Run it locally

```bash
docker compose up -d            # Postgres + Redis
cp .env.example .env            # fill in the Clerk keys
pnpm install
pnpm db:migrate                 # applies migrations, generates the client
pnpm db:seed                    # state rules + a demo tenant
pnpm dev                        # web on :3000, engine on :4000
```

`pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` are what CI runs.
