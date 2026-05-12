---
name: video-generation
description: Generate videos with the native video_generate tool.
metadata:
  hybridclaw:
    category: media
user-invocable: true
---

# Video Generation

Use the native `video_generate` tool when the user asks you to create, generate,
render, or make a deliverable video.

Do not use `video_generate` for image generation or video understanding. Use
`image_generate` for still images and the appropriate vision/video analysis
tooling for inspection.

## Workflow

1. Call `video_generate` with `action: "list"` if you need to check whether a
   video provider is configured or explain missing auth/model setup.
2. For generation, pass a clear `prompt` and optional `aspectRatio`,
   `resolution`, and `durationSeconds`.
3. The native provider layer supports OpenAI Sora 2 Pro / Sora 2 and Google
   Veo 3.1 Fast / Veo 3 when those providers are configured.
4. Treat provider `warnings` as user-relevant when they change requested
   options such as aspect ratio, resolution, or duration.
5. Return the generated artifact directly in the final response. The tool owns
   provider auth, provider quirks, file persistence, and media delivery paths.

Keep prompts concrete and cinematic. Include subject, movement, camera angle,
duration, aspect ratio, lighting, style, and any required audio direction when
the selected provider supports audio.
