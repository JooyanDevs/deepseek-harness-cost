# Contributing

Issues and pull requests are welcome.

## Before you open a pull request

- **No dependencies and no build step**, please. The package is plain ESM; the
  browser half takes React from the Host module table.
- Keep the Host and Client halves in sync: a value the Host sends to the
  browser is described in the same change's tests.
- Run the checks:

```
node --check index.js
node --check client.js
node test/fold.test.mjs
```

- Add an entry under `## Unreleased` in `CHANGELOG.md` for anything a user can
  notice.

## Changing the Host route

The route under `/chat-cost/api` serves account data. It must stay behind the
Harness Connection fence (`connection.requestRejection`) and must fail closed
when that seam is unavailable. A change that weakens either rule will be
rejected.

## Reporting a security problem

Do not use an issue; follow [SECURITY.md](SECURITY.md).
