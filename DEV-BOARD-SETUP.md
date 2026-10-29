# Developer hub: switching on the live board

`dev.html` is the developer hub, linked as "For developers" in the site footer. It has:
- a project board of tasks: Board, Table, Timeline, My work, Inbox and Handbook views
- a progress strip: live checks, the handoff countdown, % of projects at the target level, and the owner checklist
- handoff levels (Bronze / Silver / Gold) per project
- the Handbook: how the site works, the owner checklist, how-tos, rules, accounts and every page

Without any setup it shows the snapshot in `dev-content.js` with tasks made from each project's "What's next"
items. Everything people change is saved in the club's Firebase project (`give-a-paw`, the same one the design log
uses) under `devboard/`.

## Publishing the rules (about 2 minutes, again whenever database.rules.json changes)

1. Open the [Firebase console](https://console.firebase.google.com/project/give-a-paw/database) and go to
   **Realtime Database → Rules**.
2. Check that the top-level sections in the console (`sessions`, `anatomy`, `designlog`, `cases`, `devboard`) match those
   in `database.rules.json`. That file is in the give-a-paw working folder (and the private workshop repository), not
   in the public repository. If the console has a section the file doesn't, stop and add it to the file first.
3. Replace everything with the contents of `database.rules.json` and press **Publish**.
4. Reload `dev.html`. Under **Handbook → Live checks**, the database check should say the board can be read.

Google sign-in is already enabled, and `giveapaw.github.io` and `localhost` are already authorized domains.

## Who can do what

The team list is the design log's: `designlog/team/<account ID>` = `true`. One list covers both.

| Data under `devboard/` | Who can read | Who can change |
|---|---|---|
| `tasks/<id>`: title, project, state, assignee, due date, labels, details | Anyone | Team |
| `updates/<project>/<id>`: status updates (on track / at risk / off track) | Anyone | Team can add; nobody edits them |
| `triage/<id>`: "Report a problem" | Anyone | Anyone signed in with Google can report; the team accepts, declines or marks duplicates |
| `projects/<id>`: status, health, progress, owner, verified stamp, notes | Anyone | Team |
| `people/<account ID>`: name and role shown on the board | Anyone | Each team member, their own entry only |
| `checklist/<id>`: owner checklist ticks, who has it now, a note | Anyone | Team |
| `campaign`: handoff date and target level | Anyone | Team |
| `checkhistory/<check>/<day>`: one result per live check per day (the history bars) | Anyone | Team members' browsers write it after the checks run |
| `notice`: the handoff note | Anyone | Team |
| `history/<id>`: the activity feed | Anyone | Team can add; nobody edits them |

The board is public to read, so keep notes short and leave out passwords, keys and owners' personal details.

To add someone: they open `dev.html`, press **Sign in to edit**, go to **Handbook → Team**, press **Copy account ID**
and send it to you. You add it under `designlog → team` in **Realtime Database → Data** with **+** (never **Import
JSON** on the database root).

The history bars fill in on days when a team member opens the hub. Days without data stay grey.

## Trying it without the database

`dev.html?demo=1` uses sample data and keeps every change in your own browser.

## Keeping it up to date

- `dev-content.js` is the snapshot: projects, accounts, how-tos, rules and the owner checklist. Edit it when something
  big changes, so the page still makes sense if the database is unreachable.
- `dev-pages.js` lists the public pages. Run `python tools/dev_pages.py` after adding, renaming or removing a page.
  Private and local-only pages are listed in `PRIVATE` in that script and are never shown.
- Tasks made from the snapshot are replaced by the board's copy as soon as someone changes them; deleting one leaves
  a marker so it doesn't come back.
- Tests: `python tests/run_all.py dev-hub` (see `tests/README.md`).
