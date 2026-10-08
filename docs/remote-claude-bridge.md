# Remote Claude sign-in with the local callback bridge

Install the bridge on the computer running your browser. Configure it to connect to the same remote machine running DSH. Claude still redirects to `http://localhost:53692/callback`; the bridge forwards that callback through SSH. Claude credentials are exchanged and stored by remote DSH.

## First-time setup

Use Node.js `^22.19.0 || >=24` and a package build containing the `dsh-claude-bridge` command. For an unpublished development build, build and verify the checkout, pack it, then install its tarball globally:

```bash
pnpm install --frozen-lockfile
pnpm run check
npm pack --ignore-scripts
npm install --global ./dsh-coding-subscription-oauth-<version>.tgz
```

Keep that package and Node installation at stable locations if installing the macOS background service. Its LaunchAgent records absolute executable paths and the current executable `PATH`, including any installed `gcloud` command. It does not copy the rest of your environment or store account credentials.

For ordinary SSH, first connect interactively to your configured SSH alias and verify its host identity. Configure working key authentication. The bridge will not accept a new host key or bypass host-key checks.

```bash
ssh dsh-example
dsh-claude-bridge run --origin https://example.com --ssh-host dsh-example
```

For Google Cloud IAP, install the Google Cloud CLI, authenticate it yourself, and verify that your account can connect to the selected instance. The bridge does not run a login command, grant access, or change IAM.

```bash
gcloud compute ssh example-vm --project example-project --zone us-central1-a --tunnel-through-iap
dsh-claude-bridge run --origin https://example.com --gcp-instance example-vm --gcp-project example-project --gcp-zone us-central1-a
```

If you do not know the instance name, use `--gcp-instance auto` and omit the zone:

```bash
dsh-claude-bridge run --origin https://example.com --gcp-instance auto --gcp-project example-project
```

Automatic discovery uses your already active `gcloud` account. Within the configured project, it requires exactly one instance with label `workload=devbox` and `owner-email` metadata matching that account, and the instance must be running. It derives the instance name and zone without displaying the inventory or account metadata. It does not switch accounts or authenticate on your behalf. The same automatic options work with `install`; discovery happens when the helper starts, rather than during installation.

Replace `https://example.com` with your DSH origin and configure only one transport. An SSH alias may include `user@hostname`. The configured origin is exact; other websites cannot start a login through this bridge.

## Start automatically on macOS

Run `install` once with the same connection options after verifying a foreground run:

```bash
dsh-claude-bridge install --origin https://example.com --ssh-host dsh-example
```

Or use the GCP instance, project and zone options with `install`. This starts a per-user LaunchAgent immediately and again when you log in. The file has mode `0600` and label `io.dsh.claude-callback-bridge`. Repeating an identical installation is safe. A conflicting file or configuration is preserved; inspect it, uninstall the owned bridge, and reinstall deliberately to change the connection target. No DSH restart is needed to start the local helper.

On other systems, keep `run` active during sign-in. Ctrl+C or SIGTERM closes the helper's own listener and tunnel.

## Sign-in flow

1. In remote DSH, choose the local bridge sign-in option.
2. The browser opens a top-level local bridge page at `http://127.0.0.1:53700/start`. This is a navigation, not a cross-origin browser fetch. The bridge checks the configured DSH origin and pending Claude challenge.
3. The bridge prepares its loopback callback receiver at port `53692`, establishes SSH forwarding, and verifies readiness before opening Claude.
4. Authorize with Claude. The bridge forwards the matching callback to remote DSH without copying or reading your clipboard.
5. DSH verifies OAuth state and PKCE, exchanges credentials, and updates its existing account status. Keep the DSH settings page open to see the final result.

An HTTP `200` from the native callback receiver means the callback was delivered. It does not prove that credential exchange or storage succeeded. DSH's actual signed-in status is authoritative. The helper stops its temporary tunnel after callback delivery, cancellation, failure, or its bounded sign-in timeout; the background helper remains available for your next login.

## Connection failures and fallback

- **Local port occupied:** stop the other callback helper or foreground bridge and retry. The bridge does not terminate an unrelated process. Its control listener uses port `53700`; its active Claude callback uses port `53692`.
- **SSH identity or authentication failure:** establish and verify the SSH connection interactively first. Do not disable known-host checks.
- **GCP needs reauthentication:** authenticate the Google Cloud CLI yourself, verify the IAP connection, then retry sign-in. The bridge will not prompt for credentials in the background.
- **Wrong remote machine:** use the machine that generated the pending DSH authorization challenge. The receiver becomes ready only after its tunnel reaches the expected callback listener.
- **Timeout or canceled attempt:** start a new login. Preparation is bounded to 30 seconds and a pending bridge sign-in expires after five minutes.
- **Helper unavailable:** use the existing browser sign-in fallback. After Claude redirects, copy the complete callback address and paste it into DSH; DSH validates and submits it automatically.

## Remove the macOS background helper

```bash
dsh-claude-bridge uninstall
```

This unloads and removes only the LaunchAgent owned by this command. Other LaunchAgents, your SSH/GCP configuration, the DSH service, and provider credentials are preserved. Stop any separately started foreground `run` process with Ctrl+C.
