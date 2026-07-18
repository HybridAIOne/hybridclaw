# HybridClaw WhatsApp plugin

This package provides the optional WhatsApp Web channel transport for
HybridClaw. Install it with:

```bash
hybridclaw plugin install @hybridaione/hybridclaw-whatsapp
```

From a HybridClaw source checkout, run `npm run build` and then either enable
the in-repo plugin or install a local copy:

```bash
hybridclaw plugin enable whatsapp
hybridclaw plugin install ./plugins/whatsapp
```

The plugin keeps WhatsApp transport dependencies outside the core HybridClaw
package, Docker image, and desktop bundle. Existing linked sessions continue to
use `~/.hybridclaw/credentials/whatsapp`.
