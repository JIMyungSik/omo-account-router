# Security Policy

## Reporting a vulnerability

Please report security issues **privately** (do not open a public issue with exploit details).

Include: affected version/commit, steps to reproduce, and impact.

## What OAR stores

- OAuth / API credentials under `~/.oar/vault` (file mode `0600`)
- Unix socket `~/.oar/oar.sock` (mode `0600`)
- Optional usage cache `~/.oar/usage-cache.json`

Anyone with local access to your user account can read these files. Protect your machine login.

## Safe practices

- Do not commit `~/.oar/`, `auth.json`, or vault dumps
- Do not paste tokens into chat logs or issues
- Prefer `oar login` / official agent `/login` flows over pasting secrets
- Review `scripts/install.sh` before running it

## Canonical distribution

Only install from this GitHub repository (and releases you trust). Be wary of third-party zip archives that claim to be OAR.
