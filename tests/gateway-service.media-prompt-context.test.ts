import { describe, expect, test } from "vitest";
import { buildMediaPromptContext } from "../src/gateway/gateway-service.js";

describe("buildMediaPromptContext URL fallback hint", () => {
  test("offers the URL fallback only for Discord CDN attachments", () => {
    const discord = buildMediaPromptContext([
      {
        path: "/discord-media-cache/2026-09-04/photo.png",
        url: "https://cdn.discordapp.com/attachments/1/2/photo.png",
        originalUrl: "https://cdn.discordapp.com/attachments/1/2/photo.png",
        mimeType: "image/png",
        sizeBytes: 10,
        filename: "photo.png",
      },
    ]);
    expect(discord).toContain("Use Discord CDN MediaUrls as fallback");

    const teams = buildMediaPromptContext([
      {
        path: "/uploaded-media-cache/2026-09-04/original.png",
        url: "https://smba.trafficmanager.net/de/tenant/v3/attachments/abc/views/original",
        originalUrl:
          "https://smba.trafficmanager.net/de/tenant/v3/attachments/abc/views/original",
        mimeType: "image/png",
        sizeBytes: 10,
        filename: "original",
      },
    ]);
    expect(teams).not.toContain("as fallback");
    expect(teams).toContain("cannot be fetched by tools");
  });
});
