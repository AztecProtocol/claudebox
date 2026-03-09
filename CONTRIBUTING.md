# Contributing to ClaudeBox

Thanks for your interest in contributing to ClaudeBox! This guide covers the basics of setting up a development environment, running tests, and code conventions.

## Development Setup

1. Clone the repo and install dependencies:

```bash
npm install
```

2. Start the server in development mode (HTTP only, no Slack):

```bash
npx tsx server.ts --http-only
```

This launches the HTTP dashboard without requiring Slack credentials, which is the easiest way to iterate locally.

## Running Tests

Run the full test suite with:

```bash
node --experimental-strip-types --no-warnings --test tests/
```

You can also target specific test directories:

```bash
# Unit tests (libclaudebox + proxy)
node --experimental-strip-types --no-warnings --import ./tests/setup.ts --test 'tests/libclaudebox/**/*.test.ts'
node --experimental-strip-types --no-warnings --test tests/unit/*.test.ts

# Integration tests (require Docker)
npm run test:credproxy
npm run test:proxy
```

## Code Style

- **TypeScript** — all source files use TypeScript (`.ts`)
- **No semicolons** — omit trailing semicolons
- Use `const` by default, `let` when reassignment is needed
- Prefer early returns over deeply nested conditionals
