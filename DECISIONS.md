# Decisions

## RCB-2026-10-08 — Local Claude callback bridge

- **Tier / owner:** F1 / implementation task owner.
- **Goal:** A configured browser computer can complete remote Claude authorization without copying the callback. Remote DSH's persisted provider status is the acceptance result.
- **Facts:** The pinned OAuth implementation starts a loopback listener at port 53692 before publishing a challenge, validates state and PKCE, and returns callback HTTP 200 before credential exchange finishes. A remote browser's localhost points to the browser computer.
- **Choice:** An opt-in local daemon receives a challenge through top-level browser navigation, pins the configured DSH origin and SSH/IAP destination, checks the remote listener through an independently owned tunnel, then opens Claude. It forwards one matching callback and closes only its own temporary resources. Credentials stay with remote DSH.
- **Guardrails:** No background clipboard access, cross-origin local-network fetch, arbitrary shell arguments from webpages, host-key bypass, public callback listener, or new remote credential endpoint. Preparation expires after 30 seconds; a pending callback expires after five minutes. Installed macOS startup is per user and removable.
- **Assumptions / unknowns:** The operator has existing SSH/IAP access and can complete required authentication. Real provider acceptance and a deployed host remain separate verification layers.
- **Rollback:** Select callback paste in Settings and uninstall the owned local LaunchAgent. The native OAuth flow remains available.
- **Reopen condition / review:** Review on the first real host verification, or when the provider supports an approved remote redirect and a local helper can be removed.
