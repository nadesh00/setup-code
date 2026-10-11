# setup-code

A Claude Code plugin marketplace with three mods.

| Plugin | What it does |
| --- | --- |
| `prompt-enhance` | End a prompt with ` ++` and press Enter: instead of sending it, Claude rewrites it into a sharper prompt and puts it back in the prompt bar for you to review and send. |
| `session-boost` | `/subagents` opens a live side panel of every subagent, with a one-click cheaper-model suggestion per row. `/boost` (mid-turn) starts a watcher that launches read-only helper subagents. Subagents run on the chat's own model by default. |
| `conversations` | `/conversations` lists this project's past conversations by title; click one to resume it. |

## Plugins

None of the plugins ship `commands/`, `skills/` or `agents/` folders. Each one is a single hooks module (`hooks/hooks.json` → `hooks/register.ts(x)`) that registers its commands, panels, tools and agents when a session starts.

### prompt-enhance

**What it adds**

- A `prompt.submit` hook for prompts typed in the prompt bar. No slash commands.

**How to use it**

1. Type a prompt and end it with a space and `++`, e.g. `fix the flaky login test ++`.
2. Press Enter. The prompt is not sent; the status line shows *Enhancing prompt…*.
3. The rewritten prompt lands in the prompt bar. If the bar is empty or still holds your original, it is replaced; if you started typing something else, the rewrite is appended after it.
4. Review it, edit if you like, and press Enter to send.

**How it rewrites**

- Uses the model the chat is on now (as `/model` shows it), at high effort, with a 120 s timeout.
- Gets the working directory and the last 6 messages of the conversation, only to resolve references like "that bug" or "this file". It never adds tasks from them.
- Keeps your intent, language, tone, code and paths. Short prompts stay short; a clear prompt comes back nearly unchanged.
- For a change task it adds a one-line finish line ("Done means: …"); for a long task with a real decision point, "Stop and ask me only if …"; for research, a note to mark anything unconfirmed.
- Removes "think step by step", ALL-CAPS / "IMPORTANT" emphasis and "You are an expert…" preambles.

**If something goes wrong**

- `++` on its own is dropped with *Nothing to enhance*.
- If the model doesn't answer, your original prompt is put back in the bar and a toast says why.
- If the hook itself fails, your prompt is sent as normal.

### session-boost

**What it adds**

| Item | Kind | What it does |
| --- | --- | --- |
| `/subagents` | Command | Opens the **Subagents** side panel. |
| `/boost` | Command | Starts a watcher that launches read-only helper subagents for the turn in progress. |
| `/boost stop` | Command | Stops a running boost. |
| Subagent model default | `agent.spawn` hook | Subagents run on the chat's own model unless the caller names one. |
| `session-boost:watcher` | Agent (internal) | The `/boost` watcher. Hidden from the main model. |
| `session-boost:helper` | Agent (internal) | A read-only helper started by the watcher. Hidden from the main model. |
| `mcp__session-boost__progress` | Tool (internal) | Lets the watcher wait for new main-chat activity. Only the watcher may call it. |
| `mcp__session-boost__spawn_helper` | Tool (internal) | Lets the watcher queue a helper. Only the watcher may call it. |

**The Subagents panel (`/subagents`)**

The panel opens by itself at the start of an interactive session; `/subagents` reopens it. It refreshes every 2 seconds and shows one row per subagent:

- A status mark (`●` running, `○` pending, waiting or idle, `✓` completed, `✗` failed or killed), the description, the agent type, a `[watcher]` / `[helper]` tag for boost agents, and the model it runs on.
- What it is doing now: its in-flight tool call, or its last line of text. Finished agents show their final answer.
- The kind of job it reads as: **lookup**, **coding** or **reasoning**, judged from its type, its description and the tools it has used.
- The last 12 finished agents are kept below the running ones.

**Cheaper-model suggestions**

When a cheaper model suits a row's job (Haiku 5.5 for lookup, Sonnet 5.5 for coding, Opus 5.5 for reasoning), the row shows a `▲ use <model>` button with the price and the saving, e.g. `$0.10/$0.50, 98% less`. It blinks while the subagent is still running.

- Click it and future subagents of that kind (agent type + job, e.g. *Explore lookup jobs*) start on that model. The button turns to `✓ <model>`.
- Click `✓` again to undo; that kind follows the chat's model again.
- Picks are saved across sessions and are never pricier than the chat's own model.
- Rows already on the cheapest suitable model say so instead.

**Which model subagents run on**

By default every subagent runs on the chat's own model, even when its agent definition pins one (a built-in's `haiku`, say). A model the caller names explicitly, or a pick you made in the panel, wins. Forks and workflow agents are left alone.

**Boost (`/boost`)**

1. While Claude is working on a turn, run `/boost`. (With nothing in progress it tells you so.)
2. A watcher subagent starts. It follows what the main chat does and, when a clear win shows up, launches read-only helpers: finding call sites, running the tests or build, reviewing changes so far, reading docs the main chat will need.
3. At most 3 helpers run at once; more are queued. The panel shows a line like *Boost watching: 2 running, 1 queued, 3 done*.
4. When a helper finishes, its answer is added to the main chat as a `[session-boost]` message and a toast appears. The main chat uses it if it helps.
5. The boost ends by itself when the main turn ends. `/boost stop` ends it early: no new helpers, queued ones are dropped, running ones finish and report.

Helpers can use Read, Grep, Glob, Bash, WebFetch and WebSearch, and are told never to modify anything (no edits, commits, checkouts, installs). Their answers are capped at about 300 words with `file:line` citations.

### conversations

**What it adds**

- `/conversations`: a command that opens the **Past conversations** panel.

**How to use it**

1. Run `/conversations`. The panel opens focused on the newest conversation.
2. Each row shows a title, how long ago it was last active and how many prompts you typed in it.
3. Click a row (or press Enter on it) to run `/resume <id>` for that conversation.

**What it lists**

- This project's transcripts from `~/.claude/projects/<project>/` (or under `$CLAUDE_CONFIG_DIR` if set), newest first, up to 60.
- The current session and conversations with no typed prompt are left out.

**Where titles come from**, in order:

1. Your own title, set with `/rename`.
2. Claude Code's own title or summary for the conversation.
3. A 3–7 word title written by Haiku from your first 6 prompts.
4. Your first prompt, shortened.

Titles are cached per transcript and only worked out again when the transcript changes, so the panel fills at once on later opens.

## Install

Inside Claude Code, add the marketplace once per machine:

```
/plugin marketplace add nadesh00/setup-code
```

Then install the plugins you want:

```
/plugin install prompt-enhance@setup-code
/plugin install session-boost@setup-code
/plugin install conversations@setup-code
```

Run `/reload-plugins` (or start a new session) if Claude Code asks you to.

## Updates

Plugins here carry no `version`, so an update is any new commit. To get updates automatically, run `/plugin`, open the **Marketplaces** tab, select `setup-code` and choose **Enable auto-update** (it is off by default for marketplaces you add). To update by hand: `/plugin marketplace update setup-code`, then update each plugin from the **Installed** tab.

## Developing

Each plugin is a hooks module under `plugins/<name>/hooks/`. Check one with:

```
claude plugin validate plugins/<name>
claude plugin test plugins/<name>
```
