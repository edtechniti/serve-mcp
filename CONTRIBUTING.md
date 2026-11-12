# Contributing

Thanks for your interest! Issues and pull requests are welcome.

## Setup

```sh
nvm use          # Node 22 (Node >= 22.12 required)
npm install
npm run check    # typecheck, lint, format check, tests
```

## Guidelines

- Keep changes small and focused, with tests. `npm run check` must pass.
- Build only from Serve's **public** API documentation. Don't contribute anything
  obtained under a Serve account, NDA or sandbox access.
- Never commit credentials. Use `.env` (gitignored); see `.env.example`.
- Write logs to stderr only (`src/logger.ts`); stdout carries the MCP protocol.
