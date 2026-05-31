# Commands & Scripting Reference

## Custom Commands

### Match types

Each custom command has a **Match** mode that controls how it fires.

| Mode | Fires when… | Example trigger |
|------|-------------|-----------------|
| **! Command** | A viewer types `!<trigger>` | `!hug` → fires on `!hug` |
| **Contains** | The message contains the trigger text (case-insensitive) | `hello` → fires on `hey hello there` |
| **Starts with** | The message begins with the trigger text (case-insensitive) | `!sr ` → fires on `!sr never gonna give you up` |

Multiple keyword commands can fire on the same message. Commands with the same match text fire in the order they were added.

### Variables

Custom commands support template variables in their response text.

| Variable | Value |
|----------|-------|
| `{user}` | Twitch username of the viewer who triggered the command |

**Examples**

```
! Command:  hug      →  {user} wraps the chat in a big hug ❤️
Contains:   hello    →  Hey {user}, hello to you too! 👋
Starts with: !socials →  Follow on Twitter: x.com/yourname
```

---

## Built-in Command Response Variables

The response templates for built-in commands support additional variables depending on the command.

| Variable | Available in | Value |
|----------|-------------|-------|
| `{user}` | all | Username of the triggering viewer |
| `{song}` | `!song` | Currently playing track (`Artist — Title`) |
| `{result}` | `!sr`, `!play`, `!pause`, `!next`, `!prev` | Outcome message (e.g. `Added to queue`, `▶️ Resumed`) |
| `{query}` | `!sr` | The search query the viewer submitted |

---

## Event Trigger Variables

Chat response templates in the **Event Triggers** panel support variables that reflect the event that fired.

| Variable | Follow | Cheer | Sub | Resub | Gift Sub |
|----------|:------:|:-----:|:---:|:-----:|:--------:|
| `{user}` | ✓ | ✓ | ✓ | ✓ | ✓ (gifter) |
| `{bits}` | — | ✓ | — | — | — |
| `{months}` | — | — | — | ✓ | — |
| `{count}` | — | — | — | — | ✓ |
| `{tier}` | — | — | ✓ | ✓ | ✓ |
| `{message}` | — | ✓ | — | ✓ | — |

**Examples**

```
Follow:   Welcome {user}! Thanks for the follow 👋
Cheer:    {user} dropped {bits} bits — legend!
Resub:    {user} has been subscribed for {months} months!
Gift sub: {user} gifted {count} subs to the community 🎁
```

---

## Event Trigger Scripts

Each event trigger can run a local script when it fires. Scripts must be **allowlisted** first.

### Setting up the allowlist

In **Settings → Advanced → Script Allowlist**, enter a comma-separated list of directories you trust:

```
/Users/you/stream-scripts, /home/you/scripts
```

Any script whose resolved path starts with one of these directories is allowed to run. Scripts outside the allowlist are blocked and logged.

### Script arguments

The script is called via `execFile` with these positional arguments:

```
$1  event type    follow | cheer | sub | resub | giftsub
$2  user          username (or gifter for giftsub)
$3  bits          cheer amount, or empty string
$4  months        resub month count, or empty string
$5  count         gift sub count, or empty string
$6  tier          sub tier (1000 / 2000 / 3000), or empty string
```

The script's working directory is set to the directory containing the script itself.

### Example shell script

```bash
#!/bin/bash
# /Users/you/stream-scripts/on_follow.sh
EVENT="$1"
USER="$2"

echo "New $EVENT from $USER" >> ~/stream-log.txt
```

### Example Python script

```python
#!/usr/bin/env python3
# /Users/you/stream-scripts/on_cheer.py
import sys

event  = sys.argv[1]  # "cheer"
user   = sys.argv[2]
bits   = sys.argv[3]

print(f"{user} cheered {bits} bits")  # printed output appears in the app log
```

### Notes

- Scripts have a **10-second timeout**. They are terminated if they exceed it.
- Any text written to **stdout** appears in the app's verbose log.
- Scripts run with the same user account as the app itself.
- Make sure the script file is **executable** (`chmod +x script.sh` on Mac/Linux).
