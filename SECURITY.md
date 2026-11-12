# Security

## Reporting a vulnerability

Please report security issues privately through GitHub's
[private vulnerability reporting](../../security/advisories/new) for this repository
rather than opening a public issue.

## Design notes

- Credentials are read only from environment variables and are redacted from all logs.
- Production use requires two explicit settings (`SERVE_ENV=production` and
  `SERVE_ALLOW_PRODUCTION=true`), and every delivery is subject to a fee cap
  (`SERVE_MAX_FEE_CENTS`).
- Pickup and dropoff are bound to a quote on the server side, so an assistant can't
  dispatch to an address the user didn't approve.
- Job creation is never retried automatically; lost responses are reconciled by
  looking up the order id, preventing duplicate dispatches.
- Tracking output never includes the bin unlock code.
