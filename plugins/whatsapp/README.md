# HybridClaw WhatsApp plugin

This package provides the optional WhatsApp Web channel transport for
HybridClaw. Enable it explicitly to install the package and its isolated
dependency tree:

```bash
hybridclaw plugin enable whatsapp
```

For non-interactive use, approve the dependency installation explicitly:

```bash
hybridclaw plugin enable whatsapp --yes
```

From a HybridClaw source checkout, plugin development is also explicit:

```bash
npm run check:whatsapp-plugin
hybridclaw plugin install ./plugins/whatsapp
```

The plugin keeps WhatsApp transport dependencies outside the core HybridClaw
package, lockfile, build, test suite, Docker image, and desktop bundle. Existing
linked sessions continue to use `~/.hybridclaw/credentials/whatsapp`.
