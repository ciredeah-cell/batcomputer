# Laguna Deck

A Windows control deck for local models and coding agents. One window, one
workspace, one set of approval rules — and four interchangeable drivers:

| Driver | What it is | How it runs |
|---|---|---|
| **Local model** | Any GGUF through `llama-server`, with an agent loop and real tools | Spawned and supervised by the deck |
| **Claude Code** | The `claude` CLI, with its own tools and permissions | Launched as a live session inside the deck |
| **GitHub Copilot** | The `copilot` CLI | Launched per turn, context carried with `--continue` |
| **ComfyUI** | Local image generation | Installed, started and stopped by the deck; opens in a browser or a deck window |

Built for a unified-memory mini PC (Ryzen AI Max class, where system RAM *is*
graphics memory), so the hard part isn't the chat — it's knowing whether a model
plus its KV cache fits the graphics carve-out, and what to move when it doesn't.
That's what the Deck panel is for, and why a live memory gauge sits in the
corner of every screen.

Every conversation is saved. Sessions appear in the sidebar with their titles
and message counts, switching between them restores both the transcript *and*
the model's memory of it, and closing the app is not the same as losing your
work.

Primary driver is **Laguna XS**; anything else GGUF works the same way.

---

## Install

**The easy way.** Grab the installer from
[Releases](../../releases) — `Laguna-Deck-Setup-x.y.z.exe` — or the portable
`.zip` if you'd rather not install anything. Both are built on Windows by CI
from the tagged commit.

**From source** (Node 20+):

```powershell
git clone https://github.com/<owner>/laguna-deck.git
cd laguna-deck
npm install
npm start
```

Nothing native gets compiled — no `node-gyp`, no Visual Studio Build Tools. If
`npm install` needs a toolchain, something else is wrong.

---

## What you need on the machine

### 1. `llama-server` (required for local models)

Get a prebuilt llama.cpp from
[the llama.cpp releases page](https://github.com/ggml-org/llama.cpp/releases).
On an AMD iGPU take the **Vulkan** build (`llama-*-bin-win-vulkan-x64.zip`) —
it works with the driver you already have, no SDK, no ROCm install. Unzip it
anywhere, then point **Settings → llama-server binary** at `llama-server.exe`.

ROCm/HIP is also selectable in Settings. It's worth trying if you spend a lot of
time at very long context — it processes prompts faster there — but Vulkan is
usually as fast or faster at generation on this class of iGPU, and it's the
sane default. Picking ROCm makes the deck set `ROCBLAS_USE_HIPBLASLT=1`, which
is the single biggest prompt-processing win on gfx1151.

### 2. The graphics memory carve-out (do this once)

On a unified-memory box, "VRAM" is however much RAM the driver has handed the
GPU. **AMD Software → Performance → Tuning → Variable Graphics Memory.** Set it
high, leaving the rest for Windows, then set the same number in
**Settings → GPU memory budget**. The whole Budget panel is measured against
that number, so a wrong value gives confidently wrong advice.

Spilling past the carve-out into shared memory doesn't fail — it just collapses
throughput, which is much harder to diagnose than an out-of-memory error. The
deck warns you before loading something that won't fit.

### 3. ComfyUI (optional)

Select **ComfyUI** in the sidebar. If it's already on the machine the deck finds
it and just needs a Start; if it isn't, the panel offers to set it up: it clones
the repo, builds a private Python environment beside it, and installs the torch
build you choose. On an AMD Windows box that's **DirectML**, which works on any
DirectX 12 GPU including the iGPU. Nothing is installed system-wide, and the
whole install streams into the log so a failure at step four is something you
can finish by hand.

Once it's running, its memory shows up on the same gauge as everything else, and
**Open in a deck window** puts the interface in its own window instead of a
browser tab.

### 4. The CLI agents (optional, per driver)

- **Claude Code** — install it and run `claude` once to sign in. The deck finds
  it on `PATH`, or you can point Settings at the binary.
- **GitHub Copilot CLI** — install it and run `copilot` once to sign in, or set
  `COPILOT_GITHUB_TOKEN` in the environment.

Each driver's row in the sidebar shows installed / signed-in state, so you can
tell at a glance which ones are ready.

---

## Using it

1. **Pick a workspace** (bottom left). Every tool call, every file edit, and
   every CLI session runs there, and the local agent is confined to it.
2. **Add a model**: `+` next to *Local models* for a single GGUF, or
   *Scan a models folder* to walk a directory. The deck reads each file's GGUF
   header — architecture, quantisation, expert count, context length — without
   loading the weights.
3. **Read the Deck panel** before you load anything big. It shows weights, KV
   cache, and compute buffers against your budget, and what to change if the sum
   is over. Every suggestion has an **Apply** button.
4. **Talk to it.** Tool calls appear as cards. Writes and commands wait for your
   approval unless you've relaxed the mode.

Switching driver is one click in the sidebar. Loading a different local model
unloads the current one first — on a unified box, two resident models would just
evict each other.

### Sessions

The sidebar keeps every conversation: title, message count, how long ago. Click
one to switch to it — the transcript redraws, tool cards and all, and the model
gets its own history back so it remembers what you're both looking at. **New
session** starts a clean one without changing the workspace or the driver.
Deleting is immediate and permanent.

### Status and activity

The strip under the title bar is the one line of truth about what's happening:
loading, thinking, running a tool, waiting on your approval, done. **activity**
expands a timestamped feed of everything underneath that — tool calls,
llama-server errors, CLI output, ComfyUI startup — which is where to look when
the status line says something you didn't expect.

### Launching the CLI agents

Select **Claude Code** or **GitHub Copilot** and hit **Launch**. The session
starts in the current workspace and its turns render in the same transcript as
everything else, tool calls included.

- **Claude Code** runs as one long-lived process (`-p` with
  `--input-format stream-json`), so context persists across turns in-session and
  you can see token-level streaming. Pick its permission mode in Settings —
  nothing inside the deck can answer an interactive permission prompt, so
  `acceptEdits` or `auto` is the useful setting, and `plan` is the cautious one.
- **GitHub Copilot** is one process per turn, which is how its `-p` mode works;
  the deck passes `--continue` after the first turn so the thread carries. Its
  deny list (Settings) outranks `--allow-all-tools`, so destructive shell verbs
  stay blocked even with broad permission on.
- **Terminal** hands the agent to a real terminal window — Windows Terminal if
  you have it — for slash commands, `/resume`, and the full TUI. For Claude Code
  it resumes the same session you were just in.

### Approvals

| Mode | Reads | File writes | Commands |
|---|---|---|---|
| Ask | auto | ask | ask |
| Auto-accept edits | auto | auto | ask |
| Auto-accept | auto | auto | auto |

Anything matching a destructive pattern — recursive delete, disk format,
registry delete, `git reset --hard`, pipe-to-shell — **always** asks, in every
mode, and shows you the exact command line. Read-only commands (`git status`,
`ls`, `nvidia-smi`, …) are auto-approved, but only when the command line has no
shell operators: `git log | rm -rf x` is classified by the `rm`, not the `git`.

---

## The Deck panel

**System** — live memory, sampled every two seconds. A gauge of system RAM with
the share held by the deck's own processes (llama-server, ComfyUI, the CLI
agents) called out separately, a three-minute history chart with the GPU budget
marked on it, and per-process numbers. On a unified-memory box this is the
honest picture: whatever a model holds is RAM Windows cannot have. Dedicated
VRAM appears too when `nvidia-smi` or `rocm-smi` can report it.

**Budget** — a stacked meter of weights / KV cache / compute buffers against your
GPU budget, with the numbers behind it:

- **Read per token** — for an MoE, only the experts that fire count, so a 30 GiB
  model with 8-of-64 routing reads a few GiB per token, not 30.
- **Expected decode** — that figure against your memory bandwidth at ~70% of
  theoretical peak. Decode on these boxes is a bandwidth problem, not a compute
  problem, which is why this estimate is usually close.
- **Fits budget** — and if not, by how much.

**Offload** — the launch profile, as editable fields: context, KV cache quant,
flash attention, `-ngl`, `--n-cpu-moe`, batch and micro-batch sizes, threads,
`--mlock`, `--jinja`, a draft model for speculative decoding, and the port. It
shows the exact `llama-server` command line it will run, so nothing is hidden.
Changes save as you type and apply on the next load.

**Log** — `llama-server`'s own output, with a second tab for ComfyUI. First place
to look when either fails to start.

### Things worth knowing

- **`--n-cpu-moe` is the cheap offload.** On an MoE, expert tensors are most of
  the file and only a fraction fire per token, so pushing some layers' experts
  to CPU memory frees a lot of graphics memory for relatively little speed.
  That's why the planner reaches for it first rather than cutting `-ngl`.
- **`q8_0` KV cache** roughly halves cache memory for a quality difference you
  will struggle to measure. It's the default here.
- **Micro-batch (`-ub`) drives prompt-processing speed** on a wide memory bus.
  512 is a sane floor; raising it costs compute buffer.
- **Speculative decoding is close to free when you're bandwidth-bound.** Point
  the draft-model field at a small model from the same family and the big model
  verifies several tokens per pass.
- **Flash attention** defaults to the explicit `--flash-attn on`. If you're on an
  older llama.cpp that takes `-fa` as a bare flag, set it to `auto`, which omits
  the argument entirely.

---

## Troubleshooting

**"llama-server exited (code 1)"** — open **Server log**. Usually either a bad
model path or an allocation failure. If it's allocation, you're over the
carve-out: apply the Budget panel's suggestion, or raise Variable Graphics
Memory.

**Loads fine, generates at a crawl** — you've spilled into shared memory. The
meter will show it, and the fix is the same: smaller KV cache, more
`--n-cpu-moe`, or a bigger carve-out.

**The model talks about calling a tool but nothing runs** — its chat template
isn't producing structured tool calls. Check `--jinja` is on in the Offload tab.
The deck also recovers `<tool_call>{…}</tool_call>` and fenced-JSON shapes from
plain text and marks those cards `text`, but a template fix is better.

**Claude Code launches and immediately ends** — it's almost always auth or
permission mode. Run `claude auth status` in a terminal, and remember that in
`-p` mode a permission prompt nobody can answer ends the run.

**Copilot says it isn't signed in** — run `copilot` once in a terminal to log
in, or set `COPILOT_GITHUB_TOKEN`.

**ComfyUI won't install** — the panel refuses to start unless git and Python are
both on PATH, and says which one is missing. Install those first. If the torch
step fails, the log has the exact `pip` command that failed, which you can run
yourself in `ComfyUI/.venv`.

**Bandwidth shows "unknown"** — the deck only derives bandwidth for CPUs it
recognises. Everything still works; the throughput estimate is just omitted
rather than guessed.

---

## How it's put together

```
electron/
  main.js              app lifecycle, IPC, approval routing, cleanup on quit
  preload.js           the only renderer→main bridge (named channels, nothing else)
  selftest.js          headless test suite: npm run selftest
  lib/
    config.js          one JSON file in userData, written atomically
    sessions.js        persisted conversations: transcript + model-facing history
    monitor.js         live RAM / process / VRAM sampling with a short history
    comfy.js           ComfyUI detect, install, supervise, /system_stats
    hardware.js        RAM / GPU / DIMM probe, memory-bandwidth derivation
    gguf.js            GGUF header reader (metadata only, never the weights)
    planner.js         KV-cache maths, fit analysis, offload advice, argv builder
    llama.js           llama-server supervisor: spawn, health, log, teardown
    tools.js           shell / read / write / edit / ls / glob / grep + risk classes
    agent.js           the agent loop, history trimming, approval gating
    backends/local.js  OpenAI-compatible streaming, tool-call assembly + recovery
    cli-agent.js       Claude Code and Copilot CLI session drivers
renderer/
  index.html           sidebar, transcript, deck panel, settings
  app.js               state, event handling, offload form, approval cards
  styles.css           one stylesheet, no frameworks
```

Two test commands, both headless, both in CI:

- `npm run selftest` (38 checks) builds a synthetic MoE GGUF and reads it back,
  checks the offload maths end to end, exercises the tool sandbox (path escapes
  and destructive-command classification included), runs the real agent loop
  against a mock OpenAI-compatible server that emits a tool call, and covers
  session persistence and ComfyUI detection — no GPU, no model, no Windows.
- `npm run smoke` boots the actual Electron window under Xvfb, drives it
  (add a model, start a session, switch drivers, open each panel) and asserts
  the renderer came up clean. It has already caught a CSP violation and an
  un-rendered topbar that the node-only tests could not see.

## Known limits

- **Estimates are estimates.** Fit and throughput numbers come from GGUF metadata
  and derived bandwidth, not from measurement. They're close enough to plan with,
  and the Server log is the ground truth.
- **One local model at a time.** Deliberate: on unified memory the second one
  evicts the first.
- **No PTY.** Both CLIs run in their non-interactive modes, which is what makes
  the install dependency-free. The **Terminal** button is the escape hatch when
  you want the real TUI.
- **Copilot turns are one process each** — that's its `-p` design, not a
  shortcut here.
- **Windows-first.** The code runs on Linux (that's where the tests run) but the
  hardware probe, the installer, and the tuning advice target Windows.
- **ComfyUI is launched, not embedded.** The deck manages the process and the
  environment; the node editor is ComfyUI's own interface.

MIT.
