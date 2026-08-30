# Security Policy

Relay is pre-1.0 alpha software that can observe and control parts of a developer workstation.
Please treat potential security problems as private reports, not public issues.

## Supported versions

Only the current `main` branch is actively maintained during the alpha period.

## Reporting a vulnerability

1. Do not publish the vulnerability in a GitHub issue, discussion, commit, or pull request.
2. Use GitHub's private vulnerability reporting for this repository when it is enabled.
3. Until that setting is enabled, contact the maintainer privately through the
   [piyushptiwari1 GitHub profile](https://github.com/piyushptiwari1) with the subject
   `Relay security report`.

Include a clear impact description, affected component, reproduction steps, and a minimal proof of
concept that excludes real credentials and private project content.

## Alpha deployment boundary

Do not expose the local controller or experimental relay directly to the public internet. Current
public-release hardening work includes capability enforcement, token expiration and revocation,
privileged-action auditing, TLS relay transport, rate limits, and mobile push reliability.

## Security expectations for contributors

- Never commit access tokens, cloud credentials, device grants, private keys, or production data.
- Do not weaken pairing, encrypted transport, path containment, or approval checks to simplify a
  test.
- Add tests for authentication, authorization, replay, and error paths when changing them.
- Report accidental secret exposure immediately and rotate the credential before opening a pull
  request.