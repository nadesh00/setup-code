# setup-code

A Claude Code plugin marketplace with three mods.

| Plugin | What it does |
| --- | --- |
| `prompt-enhance` | End a prompt with ` ++` and press Enter: instead of sending it, Claude rewrites it into a sharper prompt and puts it back in the prompt bar for you to review and send. |
| `session-boost` | `/subagents` opens a live side panel of every subagent, with a one-click cheaper-model suggestion per row. `/boost` (mid-turn) starts a watcher that launches read-only helper subagents. Subagents run on the chat's own model by default. |
| `conversations` | `/conversations` lists this project's past conversations by title; click one to resume it. |

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
