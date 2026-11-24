# Security policy

## Supported versions

The latest published `1.x` release receives security fixes. Older releases are
not patched; update through the **Plugins** page in DeepSeek Harness.

## Reporting a vulnerability

Please do **not** open a public issue for a security problem.

Use GitHub's private reporting instead:
[Security → Report a vulnerability](https://github.com/JooyanDevs/deepseek-harness-cost/security/advisories/new)
on this repository. If that is unavailable, open a normal issue that only says
you have a security report and asks for a private channel — include no details
in it.

A useful report contains:

- the version, the Host OS, and whether you run Desktop or Web;
- what an attacker controls (a Session log, the model route, a local web page,
  the plugin configuration, …);
- the smallest reproduction you know of, and what the attacker gains;
- anything that limits impact (needs the login token, needs local access, …).

You can expect an acknowledgement within a few days and a fix or a reasoned
response as soon as the report can be reproduced.

## Scope

In scope:

- the plugin code in this repository (`index.js`, `client.js`,
  `cordis.patch.yml`, the locale files);
- the Host route it serves under `/chat-cost/api`;
- how it handles the `OPENCODE_GO_API_KEY` credential and Session-log data.

Out of scope:

- DeepSeek Harness itself — report those to the Harness project;
- the DeepSeek platform or the OpenCode API — report those to their operators;
- an owner deliberately pointing `usd.baseUrl` at their own server, or editing
  the plugin configuration on their own machine.

## What this plugin does with your data

It reads usage already recorded in local Session logs and makes two HTTPS `GET`
requests to the configured OpenCode origin. It has no telemetry. See
[Privacy and network access](README.md#privacy-and-network-access).
