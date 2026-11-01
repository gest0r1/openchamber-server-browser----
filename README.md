# Server Browser for OpenChamber

[Русская документация](README.ru.md)

**Version:** `0.9.0-dev.2` · **Status:** experimental; manual authentication and host-level recovery are not yet fully verified.

Server-side Chrome for OpenChamber. Agents use the `openchamber_web` tool; a person can view the **same browser page** in the Server Browser panel, sign in, and hand control back. Chrome runs on the OpenChamber **server**, independently of a Windows desktop client.

This fork adds **persistent authentication per project**, rather than the temporary per-chat profiles in the [original extension](https://github.com/JosueGalRe/openchamber-server-browser). It builds on the original extension's browser-provider and shared-surface implementation, with attribution in [LICENSE](LICENSE) and [NOTICE](NOTICE).

## Requirements and installation

- OpenChamber **2.0.1+**, with the Server Browser extension API (some agent actions require OpenChamber 2.5+).
- Google Chrome or Chromium **109+** on the **OpenChamber host**.
- A host service runtime supporting **Node.js 22+** for development. Git is used for identifying common repositories/worktrees.
- An approved extension service permission. Headless Chrome does not require a local monitor or Windows client.

In **Settings → Extensions → Add**, paste:

```text
https://github.com/gest0r1/openchamber-server-browser----.git
```

This installs the repository's default **`main`** branch directly from GitHub. OpenChamber downloads the source and starts the **prebuilt** `service/main.js`; manual cloning and building are unnecessary. If the original Server Browser is already installed, choose **Replace/Reinstall** for the same extension ID and review any newly requested permissions (including `git`). Then select **Server Browser** in **Settings → General → OpenChamber Tools → Browser provider**.

For testing a non-default branch, append `#branch-name` to the `.git` URL. Git-installed extension updates track the selected ref and compare the version in `package.json`. A browser-provider service starts on demand; normally neither a Windows client nor the OpenChamber host needs restarting after installation.

## First login and agent workflow

1. Open the intended **project and chat** in OpenChamber.
2. Ask the agent: “Use `openchamber_web` with `browser.open` to open https://example.com and stop. I will sign in manually.”
3. The **Server Browser** panel shows the server-side page. Click/type inside the panel to take control, sign in, then select **Hand back to agent**. The host refuses agent actions while you hold control.
4. Open a **new chat within the same project** and visit the same site with `openchamber_web`. Cookies and LocalStorage are shared with the first chat.
5. Switch to a different project to check that the browser session is separate.

Opening the panel alone does **not** start Chrome. The panel offers **Open for this chat** when it receives a valid current project directory and session ID; otherwise the first agent browser action starts it. The address bar and controls stay disabled until a scope exists. OpenCode desktop's built-in `browser.*` tools are different; on a web host, agents must use `openchamber_web`.

A site may still require login again when its cookies expire or it stores authentication only in SessionStorage, revokes tokens server-side, or has SSO/2FA requirements. Persistent profiles cannot bypass the site's authentication policy.

## Project profiles and lifecycle

- **Git repository:** project identity is derived from the canonical **common Git directory**. All worktrees of that repository share **one profile**.
- **Non-Git directory:** identity is derived from its canonical absolute path. Moving or renaming a directory may create a different identity.
- **Different projects:** independent Chrome processes, profiles, cookies, LocalStorage, and target ownership.
- **Different chats in one project:** share Chrome authentication but own **separate tabs**. One chat is not allowed to act on another chat's target through the extension API.
- **Storage:** `~/.local/share/openchamber-server-browser/profiles/<sha256-project-id>/` by default (resolved from the server user's home). The profile directory is mode `0700`, is **not** placed in Git, and is preserved when Chrome or the extension stops normally.
- **Scope limits:** at most four live chat scopes; an idle scope closes after five minutes. A scope may be evicted to make room once inactive long enough. An unattended host-managed provider service can also be stopped by OpenChamber. These events close tabs and Chrome, **not** the persistent profile.
- **Restart:** a later request launches Chrome with the saved project profile. Open tabs, temporary JS state, transient SessionStorage, and history are **not** guaranteed to be restored.

`0.9.0-dev.2` clears a stale Chrome `DevToolsActivePort` before launching a new process, rejects a profile already used by a live Chrome, clears failed startup state, and attempts a fresh Chrome start after an unexpected exit. The *next browser action* starts recovery; an interrupted action is **not** automatically replayed. Diagnostic logs include the Chrome exit code/signal without profile data.

## Configuration and local-network security

The extension loads an optional `config.json` located in its installation directory (copy `config.example.json`). This file may need to be backed up when replacing the installed extension. Restart **the extension service** after editing the configuration.

```json
{
  "profileRoot": "/home/opencode/.local/share/openchamber-server-browser/profiles",
  "allowedOrigins": ["http://127.0.0.1:3000", "http://localhost:3000"],
  "allowedNetworks": [{ "cidr": "192.168.1.0/24", "ports": [3000, "5173-5199"] }],
  "discoverDevServers": false
}
```

`profileRoot` must be an **absolute server path**; omit it to use the default. `allowedOrigins` grants exact host/port origins. `allowedNetworks` permits narrowly scoped private IPv4 blocks and ports. Internal and loopback addresses are **blocked by default**; do not casually permit metadata, administrative or unrelated service ports. `discoverDevServers: true` discovers eligible active loopback development listeners, but widens the attack surface; keep it **false** unless necessary. The allowlist proxy is attached to each **project Chrome process**, not a temporary incognito context.

**Security boundary:** Chrome profiles hold authentication material. Protect server access, filesystem backups, and the account running OpenChamber. Project separation is at the browser profile/extension API layer, **not an OS-level sandbox** against malicious code running as the same user. Never commit `config.json` with secrets or the profile directory. To revoke a saved login, log out on the website; for complete local deletion, stop the extension service and remove only that project's profile directory after confirming its identity.

## Features and limitations

Available: user/agent control handoff; tabs and popups; navigation, keyboard/mouse, snapshots and captures; mobile/tablet/desktop viewport emulation; optional native single-select compatibility; error/warning counters; and **Browser inspector** for the visible page's console, network and JavaScript evaluation.

Not included: embedded Chrome DevTools, a graphical profile manager or one-click profile deletion, a guaranteed SSO/2FA flow, automatic replay of failed agent commands, and independent simultaneous control by multiple viewers. The current UI displays one selected session at a time. The original extension's broader feature/validation history is available in its Git repository; this fork's changes should be judged separately.

## Troubleshooting

| Symptom | Check / action |
| --- | --- |
| Panel says “Ask the agent to open a page” | Open a real project/chat and call `openchamber_web → browser.open`, or click **Open for this chat** when available. |
| Agent says the user has control | Release control in the browser panel before retrying. |
| `ECONNREFUSED 127.0.0.1:<port>` | Determine whether the port is a **Chrome DevTools endpoint** or the **extension service**. Different ports are normal. Check the Chrome process, extension status and service logs. Version `0.9.0-dev.2` fixes one stale-DevTools-port/retry path; it does not establish the cause of every crash. |
| Panel says “Extension service stopped” | Check permission/enablement and the extension service health; restart the extension via Settings if necessary. Restart OpenChamber only when the host cannot recover. |
| Site asks to sign in again | Check the correct project/worktree identity, server-side cookie expiration, and whether the site uses SessionStorage-only authentication. |
| Local development server is blocked | Add only the needed `allowedOrigins`, then restart the extension service. |

A failed field test on **2026-11-01** showed the service answering `/health` while no Chrome process was running and an agent request failed to connect to a stale Chrome DevTools port. The exact reason Chrome exited was **not established**. The retry and stale-port fixes above address confirmed code weaknesses, but full independent recovery still needs a host-level test.

## Build, tests and current verification

```sh
bun install --frozen-lockfile
bun run build
bun run test
bun run check
bun run package
```

`service/main.js`, `panel/main.js` and `panel/inspector.js` are committed installable bundles; after source changes **rebuild them** before updating GitHub. Tests involving Chrome may skip when Chromium is absent.

**Current fork verification:** JavaScript syntax checks and isolated fault-injection checks were run, and regression tests were added for stale DevTools ports, startup retry, shared cookies/storage across chats, restart persistence, Git worktree identity and cross-project isolation. **The complete repository test suite and a successful real-world authenticated recovery test have not yet been confirmed.** Do not interpret a merged commit as full production validation.

## Source and license

Original implementation: [JosueGalRe/openchamber-server-browser](https://github.com/JosueGalRe/openchamber-server-browser), originating from [OpenChamber PR #3425](https://github.com/openchamber/openchamber/pull/3425). MIT — see [LICENSE](LICENSE), [NOTICE](NOTICE), and [THIRD_PARTY_LICENSES](THIRD_PARTY_LICENSES).
