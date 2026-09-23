# pi-focus

A Pi extension that keeps tool output compact and shows execution progress above the editor.

## Behavior

- Shows compact call and result summaries for `read`, `bash`, `edit`, and `write`, hiding streaming output while a tool runs.
- Keeps Pi's theme-aware tool backgrounds for pending, successful, and failed calls.
- Shows a short error excerpt when a tool fails.
- Updates a persistent widget with running tools, completed calls, failure count, the latest failure, and the most recently modified file.
- Tracks parallel tool calls separately and clears running indicators when the agent settles or is aborted.
- Keeps the last run's status visible until the next run starts. Counts reset when starting a new run, switching sessions, or reloading.
- Preserves tool execution, model context, and session history without making additional model calls.

The failure count records failed calls during the run, including failures that the agent later recovers from.

## Install

Install from GitHub:

```bash
pi install git:github.com/YukiKazahana/pi-focus
```

Or try it without installing:

```bash
pi -e git:github.com/YukiKazahana/pi-focus
```

Run `/reload` after installing or changing the extension in an existing Pi session.

## Usage

Focus mode is enabled by default.

| Command | Behavior |
| --- | --- |
| `/focus` | Toggle focus mode. |
| `/focus on` | Enable compact output and the progress widget. |
| `/focus off` | Restore native tool content rendering and the previous expansion state. |

Use Pi's tool expansion shortcut, `Ctrl+O` by default, to inspect details. In fullscreen mode, tool rows also support click-to-expand.

The mode is saved in the current session branch and restored when resuming or reloading. Turning it off removes the widget and restores native tool content rendering.

## Development

Clone the repository and install the development dependencies:

```bash
git clone https://github.com/YukiKazahana/pi-focus.git
cd pi-focus
npm install
```

Load the local checkout directly:

```bash
pi -e .
```

Run the type check and tests:

```bash
npm run check
npm test
```

Tests exercise real file and shell operations, native tool rendering, expansion, errors, cancellation, parallel progress, mode restoration, and compatibility guards. They do not require a model or network access.

The extension has no third-party runtime dependencies. It uses Node.js and Pi's public extension and terminal UI APIs.

## Compatibility

Validated against Pi `0.87.1`. Development checks require Node.js 22.6 or later. Status labels and tool summaries are currently displayed in Chinese.

- Only changes presentation in the terminal UI. RPC, JSON, and print modes use the same delegated native tool execution without displaying the widget.
- Third-party tools with other names keep their own renderers and participate in progress tracking. If another extension overrides `read`, `bash`, `edit`, or `write`, load it before pi-focus: Pi uses the first extension registration for each tool name.
- Compact renderers are registered before Pi reconstructs history. Reloading or resuming a session restores historical tool rows according to the saved focus mode.
- Assistant messages, thinking blocks, images, and confirmation dialogs keep Pi's existing behavior. Use `Ctrl+T` to toggle thinking blocks separately.
