# Saved goal results

The mobile Goals tab shows prepared research, drafts and plans as dated results. The `track` tool attaches work with action `result`, the goal `id`, a `title` (200 characters), a factual `summary` (1000 characters), and a `path` relative to the owning agent workspace. Goal check-ins request this action after preparing useful work. Status updates remain separate from results.

The runtime accepts only existing regular files inside that agent workspace, checks canonical paths to reject symlink escapes, and limits each file to the apps’ 25 MB document preview limit. It saves a separate copy before attaching the title, summary, timestamp and saved path to the goal. Later edits to the source file do not rewrite the saved result. A goal accepts at most 100 results; reaching the limit fails without discarding older work.

`/track list --json` returns `results` alongside updates and milestones. Both apps show newest results first and open files through their existing authenticated document viewer. Results remain accessible after completion and reopening. Completed goal histories remain stored until explicitly deleted. Removing a goal removes its result entries, milestones and updates; the workspace copies remain files and are not deleted by removing the goal.

The apps confirm deletion and offer completion as a way to preserve history. They stay on the goal if the runtime refuses deletion or cannot be reached.

A runtime and container build with the `result` action is required to produce saved results. This feature does not create additional schedules, run an on-demand briefing, or change action permissions. References and model summaries remain untrusted data; saving a draft does not mean it was sent or published.
