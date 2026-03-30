#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const image = process.env.HYBRIDCLAW_CONTAINER_IMAGE || "hybridclaw-agent";
const target = process.env.HYBRIDCLAW_CONTAINER_TARGET || "runtime";

const result = spawnSync(
  "docker",
  ["build", "--target", target, "-t", image, "./container"],
  { stdio: "inherit", env: { ...process.env, DOCKER_BUILDKIT: "1" } },
);

if (result.error) throw result.error;
process.exit(result.status ?? 1);
