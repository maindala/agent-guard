# Security Policy

## Reporting a vulnerability

If you believe you have found a security vulnerability in `@maindala/agent-guard`, please
report it privately rather than opening a public issue.

**Contact:** it@maindala.com

Please include:

- A description of the vulnerability and its potential impact.
- Steps to reproduce, or a minimal proof-of-concept.
- The package version(s) affected.

We will acknowledge your report within **3 business days** and aim to provide an initial
assessment (confirmed / not applicable / needs more information) within **10 business days**.
If confirmed, we will work with you on a disclosure timeline and credit you in the release
notes unless you prefer to remain anonymous.

Please do not publicly disclose the issue until a fix has been released.

## Supported versions

`@maindala/agent-guard` follows semantic versioning. Only the latest published major version
receives security fixes.

| Version | Supported |
|---|---|
| 1.x   | ✅ |
| 0.2.x | ❌ (superseded — see [CHANGELOG.md](./CHANGELOG.md) for the 1.0.0 breaking-change notice) |

## Scope

This package is a client SDK: it calls a governance gateway you configure (`gatewayUrl`) and
never talks to any mAIndala-operated service unless you point it there. A vulnerability report
about the mAIndala-hosted governance plane itself (as opposed to this SDK's code) should also
go to it@maindala.com — we will route it internally.
