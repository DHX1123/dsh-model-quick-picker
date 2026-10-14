<div align="center">

# dsh-model-quick-picker

**A two-column model picker · companion plugin to [dsh-our-free-model](https://github.com/Fish-under-sea/dsh-our-free-model-fish)**

[简体中文](README.md) | **English**

<img alt="license" src="https://img.shields.io/badge/license-MIT-263146?style=flat-square">
<img alt="dependencies" src="https://img.shields.io/badge/dependencies-zero-4b6fff?style=flat-square">
<img alt="build step" src="https://img.shields.io/badge/build%20step-none-7da1de?style=flat-square">
<img alt="status" src="https://img.shields.io/badge/status-beta-f0a441?style=flat-square">

</div>

> **Companion plugin**: this is an **optional companion** to
> [dsh-our-free-model](https://github.com/Fish-under-sea/dsh-our-free-model-fish).
> It reads that plugin's per-channel **remaining credits / balance** and shows it in
> the composer — but it does **not** depend on it. Without free model installed this
> is still a complete two-column model picker; it simply shows no credits.
> The two install and uninstall independently.

## The problem

Once you have many providers, the stock model menu becomes **one long flat strip**:
dozens of models in a single list, with no indication of which provider each belongs
to, and no way to see how much quota a given channel has left.

This plugin replaces that menu with a **two-column picker with search**, and puts each
provider's **extra data** (credits / balance / quota) right where the decision happens.

## Features

| Feature | Description |
|---|---|
| **Two columns** | Providers on the left, that provider's models on the right; hovering the left column switches the right instantly |
| **Always-on search** | Typing filters across every provider; hits flatten to `provider › model` |
| **Recent** | Remembers recently selected models (localStorage, up to 6) and pins them on top |
| **Reasoning effort inline** | A persistent row of chips at the panel's foot — **click to select**, no submenu; selecting keeps the panel open so you can compare levels back to back |
| **Provider extra data** | Each provider row shows its remaining credits/balance; a composer chip mirrors the **currently selected** provider's value |
| **Effort sync** | Selecting a model carries that model's default effort; changing effort goes through the official `selectModel` channel |

## Where the extra data comes from

Three **capability-probing** adapters, matched by provider route id. If any read fails
it simply renders nothing — **never an error, never a broken picker**:

| Provider kind | Source | Key |
|---|---|---|
| Free channels (CodeBuddy / TRAE / Qoder / ZCode…) | channel-pack RPC `credits.balances` | channel id |
| Official (DeepSeek) | `GET /api/billing/balance` | vendor display name |
| Relays (pi-ai routes) | `GET /api/billing/relay-quotas` | route name |

For free channels the figures use **exactly** the same pipeline as the free model
settings page's "remaining credits" — same RPC, same `balance.total` summation, same
number abbreviation — so the two always agree.

## Install

### Via the plugin market (recommended)

Search this repository in the dsh plugin market, or give the GitHub spec directly:

```
github:DHX1123/dsh-model-quick-picker
```

### Manually

Place this directory in your profile and declare it as a bundle:

```jsonc
// <profile>/package.json
{
  "dependencies": {
    "dsh-model-quick-picker": "link:./plugins/dsh-model-quick-picker"
  },
  "dsh": {
    "profile": {
      "bundles": [ /* … , */ "dsh-model-quick-picker" ]
    }
  }
}
```

Then run `pnpm install` in that profile directory to sync the lockfile.

> ⚠️ **Never edit `package.json` without running pnpm.** A profile is a pnpm
> workspace and dshmarket runs pnpm with `CI=true` (frozen-lockfile); a manifest
> that disagrees with the lockfile fails hard and triggers the "disable third-party
> plugins" recovery, which **resets `cordis.patch.yml`** along with it. Prefer the
> market's install entry — it writes all three layers (dependency, bundles, patch
> row) correctly in one go.

### Activation

**Client plugins require a full host restart.** Refreshing the page does **not**
work: `client.js` is read and snapshotted at host startup, so only a restart
reloads it after you change the file on disk.

## Uninstall / rollback

Switch it off in the plugin market, or remove its row from `dsh.profile.bundles`
and restart. This plugin **modifies no official file**; the stock model picker
returns exactly as it was.

## How it hooks in

It **shadows** the official model seat rather than adding another entry:

```js
ctx.slots.inject('conversation.input.model', () => ctx.slots.register({
  name: 'conversation.input.model',
  priority: -10,          // official is 0; lowest renders ⇒ -10 wins
  inject: (sessionId) => { /* … */ },
}, Component))
```

The credits chip registers into `conversation.input.right` (a `list` slot) under its
own `id`, so it **coexists** with other plugins' composer controls.

Zero dependencies, no build step: `client.js` ships directly as a
`window.__ModuleLoader__.load` registration and takes React from the host module table.

## Compatibility

- Requires the dsh `0.2.0-rc` client slot contract (`conversation.input.model` as a
  `single` slot).
- Icons and theme tokens are read **defensively** (`?.` plus an error boundary): if a
  host upgrade renames an icon, this plugin steps aside quietly and **never** takes
  the model entry down with it.
- The extra-data adapters depend on other plugins' HTTP/RPC surfaces and are
  **decoration only**: if those plugins change routes, the worst case is a missing
  number.

## License

MIT

## Related

- [dsh-our-free-model](https://github.com/Fish-under-sea/dsh-our-free-model-fish) — the free-model plugin this accompanies
- [Ebony-Vinyl/dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model) — upstream original
