# Decisions

## RCB-2026-10-08 — Local Claude callback bridge

- **Tier / owner:** F1 / implementation task owner.
- **Goal:** A configured browser computer can complete remote Claude authorization without copying the callback. Remote DSH's persisted provider status is the acceptance result.
- **Facts:** The pinned OAuth implementation starts a loopback listener at port 53692 before publishing a challenge and accepts a complete callback URL through the existing authenticated code-submission route. State, PKCE, credential exchange and persistence remain native. A remote browser's localhost points to the browser computer. SSH requires additional cloud access that browser sign-in does not otherwise need.
- **Choice:** An opt-in local daemon receives a challenge through top-level browser navigation and pins the configured DSH origin. By default it prepares its local receiver, opens Claude, then returns a matching callback to the exact DSH origin in a URL fragment. The DSH client erases that fragment immediately, matches the fresh pending challenge, and submits through its existing authenticated route. It reports success only after persisted signed-in status. Explicit SSH/IAP forwarding remains an optional transport. Credentials stay with remote DSH.
- **Guardrails:** No background clipboard access, cross-origin local-network fetch, arbitrary shell arguments from webpages, host-key bypass, public callback listener, or new remote credential endpoint. Preparation expires after 30 seconds; a pending callback expires after five minutes. Installed macOS startup is per user and removable.
- **Assumptions / unknowns:** The browser has an existing DSH session and runs a package containing the return consumer; the local helper is installed on that computer. SSH/IAP access is required only for explicit native-forwarding mode. Real provider acceptance and a deployed host remain separate verification layers.
- **Rollback:** Select callback paste in Settings and uninstall the owned local LaunchAgent. The native OAuth flow remains available.
- **Reopen condition / review:** Review on the first real host verification, or when the provider supports an approved remote redirect and a local helper can be removed.
