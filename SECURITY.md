# Security maintenance

Iris is an anonymous public API. CORS is a browser policy, not authentication or
protection against paid-provider abuse. Only `/internal/refresh` uses a secret
bearer token. Never commit provider keys, refresh/deployment tokens or local
`.dev.vars`; never log credentials or raw provider requests containing them.

- CI runs full and production-only dependency audits; any reported finding fails.
- The independent weekly audit checks the default branch without deploying.
- Dependabot proposes npm and immutable GitHub Actions updates. Review the diff,
  compatibility and CI before merging; updates are not automatically accepted.

## Operator-only GitHub checks

Verify **Settings → Code security** for secret scanning and push protection.
GitHub supports secret scanning for public repositories, but availability and
enablement of each protection must be checked for this repository/account.
No live setting was changed or verified by adding this file. Enable private
vulnerability reporting if available; use it rather than posting secrets in an
issue. If a secret leaks, notify the owner and rotate it through the provider;
deleting a file does not revoke the credential.

See [GitHub secret scanning documentation](https://docs.github.com/en/code-security/secret-scanning/introduction/about-secret-scanning).
