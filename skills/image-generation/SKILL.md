---
name: image-generation
description: Generate or edit raster images with the native image_generate tool.
metadata:
  hybridclaw:
    category: media
    tags:
      - image
      - generation
      - media
      - raster
user-invocable: true
---

# Image Generation

Use the native `image_generate` tool when the user asks you to create, generate,
render, edit, restyle, or make a deliverable raster image.

Do not use `image_generate` to inspect or describe an existing image. Use
`vision_analyze` for image understanding.

## Workflow

1. Call `image_generate` with `action: "list"` if you need to check whether an
   image provider is configured or explain missing auth/model setup.
2. For generation, pass a clear `prompt` and optional `aspectRatio`, `size`,
   `quality`, and `count`. The native provider layer supports GPT Image 2,
   Nano Banana 2, Grok Imagine, and FLUX.2 when those providers are configured.
3. For image-to-image edits, pass reference media paths in the
   `image_generate` `image` or `images` arguments. Paths may come from
   `/workspace`, `/discord-media-cache`, `/uploaded-media-cache`, or safe
   current-turn Discord CDN URLs.
4. Treat provider `warnings` as user-relevant when they change requested
   options such as quality, size, aspect ratio, or count.
5. Return the generated artifact directly in the final response. The tool owns
   provider auth, provider quirks, file persistence, and media delivery paths.

Keep prompts concrete and visual. Include subject, composition, style, colors,
format, and any text that must appear in the image.
