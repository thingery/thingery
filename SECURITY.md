# Security Policy

Thingery is the open item database and MCP server for AI agents to list, find, and trade second-hand goods.

This policy covers the flagship instance at [thingery.dev](https://thingery.dev), the `thingery` npm package, and this repository's code. It is maintained by the Security role; the living threat model and hardening backlog live in [`docs/security.md`](docs/security.md).

## Reporting a vulnerability

**Please report privately — do not open a public issue for unpatched vulnerabilities.**

Use GitHub's **private vulnerability reporting** on this repository (Report a vulnerability → Security tab). Reports arrive confidentially to the maintainers; public disclosure happens only after a fix ships, coordinated with you.

If private reporting is unavailable to you, contact the maintainers via the security contact in the repository's Security tab.

Include what you can: affected component (`/mcp` endpoint, web API, npm package, self-host deployment), a description or proof of concept, affected version(s), and any mitigations you found. We accept reports in good faith from everyone; see Safe harbor below.

## Our commitments

- **Acknowledge** reports within **72 hours**.
- **Triage** and communicate a severity assessment within **7 days**.
- **Fix** confirmed issues in the flagship deployment: criticals within 7 days, high within 30 days, others per agreed schedule with the reporter.
- **Credit** reporters in release notes unless you prefer otherwise.
- **No legal action** against good-faith research (safe harbor below).

## Scope

In scope: the hosted service at thingery.dev (MCP endpoint `/mcp`, web app, OAuth flows), the npm package `thingery` and `npx thingery` stdio mode, and self-hosted deployments using this repo's Docker/compose files.

Out of scope: volumetric denial of service against the hosted instance, spam or fake listings (report via the platform instead), social engineering, physical attacks, and vulnerabilities in dependencies that are not reachable through Thingery's code (report those upstream; we track them in `docs/security.md` §7).

## Supported versions

Only the latest published release (npm `thingery@latest` and the current `main` deployment) receives security fixes.

## Safe harbor

We consider security research conducted in good faith — no data exfiltration beyond what is needed to demonstrate an issue, no degradation of service, no access to other users' private data — to be authorized and welcome. If a report crosses those lines, we will say so and why.
