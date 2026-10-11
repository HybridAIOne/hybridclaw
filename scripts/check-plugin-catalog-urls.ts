/**
 * Fails when an install URL pinned in the official channel-plugin catalog does
 * not download, so a pin to an unpublished release (#1922) breaks CI instead of
 * `plugin enable`. Reads the catalog itself; it keeps no copy of the URLs.
 */
import { getOfficialChannelPluginCatalogEntries } from '../src/channels/channel-plugin-catalog.ts';

const urls = getOfficialChannelPluginCatalogEntries()
  .map((entry) => entry.installSource)
  .filter((source) => /^https?:\/\//.test(source));

let failed = false;
for (const url of urls) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    await response.body?.cancel();
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    console.log(`ok    ${url}`);
  } catch (error) {
    failed = true;
    console.error(`FAIL  ${url}: ${(error as Error).message}`);
  }
}
if (failed) process.exitCode = 1;
