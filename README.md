# Task Date Links

Adds a real daily note link to a task when you complete it, so backlinks show what you finished each day.

The Tasks plugin writes the done date as text, such as `✅ 2026-10-10`. Text is not a link, so the daily note for that day shows nothing. The Tasks maintainers closed the request as not planned in June 2026 (issue 3372, 43 reactions) and said that another plugin should do it. Task Date Links is that plugin. It is by a different author and does not read the internals of Tasks.

<img src="https://raw.githubusercontent.com/theluckystrike/task-date-links/HEAD/docs/task-date-links.gif" alt="Complete a task with the Tasks plugin and a link to today appears, then the back-fill of old done tasks" width="720">

## Features

### A link when you complete a task

When the Tasks plugin writes a done date, Task Date Links adds a link to that day before the Tasks fields:

```markdown
- [x] Send the invoice to Ana [[2026-10-10]] ✅ 2026-10-10 ^invoice
```

The link goes before the fields on purpose. Tasks reads the fields from the end of the line, so a link after the done date would hide the date. This way, Tasks still reads every field: the dates, the priority, the recurrence rule and the block id.

The plugin finds the fields with the same rules as Tasks, in the emoji format and the Dataview format. It changes nothing in a line except to add the link, keeps Windows line endings, and skips code blocks and front matter.

<img src="https://raw.githubusercontent.com/theluckystrike/task-date-links/HEAD/docs/done-link.png" alt="The task Send the invoice to Ana is checked and shows a link to 2026-10-10 before its done date" width="720">

A recurring task works too. Tasks makes a new open copy and finishes the old one. Only the finished copy gets the link. When you uncheck a task, the plugin removes only a link that it added on completion in the same session, and not after you change a plugin setting, rename the note or back-fill it. A back-filled link and a link that you typed yourself stay.

### The daily note shows what you finished

Open the daily note and look at the Backlinks pane. Each task that you completed that day is there, with its whole line. The graph view shows the same links.

<img src="https://raw.githubusercontent.com/theluckystrike/task-date-links/HEAD/docs/backlinks.png" alt="The daily note 2026-10-10 with the Backlinks pane that lists the completed task" width="720">

### Back-fill with a preview and one undo

For old done dates, run "Link the done dates in the current note". To change only some lines, select them and run "Link the done dates in the selection".

A window lists up to 40 lines that would change, with each new link marked, and says how many more it does not show. Nothing is written until you select "Link the dates". Then "Undo the last back-fill" puts every line back. A line that you edited since stays as it is.

<img src="https://raw.githubusercontent.com/theluckystrike/task-date-links/HEAD/docs/back-fill-preview.png" alt="The preview window of a back-fill with four lines and the new links marked" width="720">

After you apply it, a notice tells you how many dates were linked.

<img src="https://raw.githubusercontent.com/theluckystrike/task-date-links/HEAD/docs/back-fill-done.png" alt="The note after the back-fill with the notice that explains the undo command" width="720">

### Your date format and link text

The plugin reads the date format of the core Daily notes plugin. You can set another moment format, such as `DD-MM-YYYY`. A format that would break a link, for example one with `#` or `|`, falls back to `YYYY-MM-DD`. A link text format such as `MMM D` gives `[[2026-10-10|Oct 10]]`.

<img src="https://raw.githubusercontent.com/theluckystrike/task-date-links/HEAD/docs/settings.png" alt="The settings tab with link on completion, the daily note format and the link text format" width="720">

### More dates and week and month notes (Pro)

Turn on the start, scheduled, due or created date, and a completed task gets a link for each one. Turn on the weekly or monthly note, and each linked date also links its week or month, such as `[[2026-W41]]` and `[[2026-10]]`. Folder rules let you use the plugin in some folders only, or skip a folder such as `Archive`.

<img src="https://raw.githubusercontent.com/theluckystrike/task-date-links/HEAD/docs/pro-settings.png" alt="The Pro settings for the created date, the weekly and monthly notes and the folder rules" width="720">

### Back-fill the whole vault (Pro)

"Link the done dates in the whole vault" does the back-fill for the whole vault, after a preview. One undo puts back all notes.

<img src="https://raw.githubusercontent.com/theluckystrike/task-date-links/HEAD/docs/vault-preview.png" alt="The preview window of a whole vault back-fill, with nine tasks in three notes" width="720">

## Install

Open Settings, then Community plugins, then Browse, and search for "Task Date Links". Select Install, then Enable.

To install by hand, download `main.js`, `manifest.json` and `styles.css` from the latest release. Put them in `<vault>/.obsidian/plugins/task-date-links/`. Reload the community plugins, then turn on Task Date Links.

## Usage

Complete a task as you do now, for example with the Tasks command "Toggle task done". When Obsidian has saved the note with the done date, the link follows in a few seconds.

Only a done date of today or yesterday gets a link on its own. Old tasks in a note that you edit stay as they are. Use the back-fill for those.

| Command | What it does |
| --- | --- |
| Link the done dates in the current note | Preview, then link every done date of the note. |
| Link the done dates in the selection | The same for the selected lines only. |
| Link the done dates in the whole vault | The same for the whole vault. Pro. |
| Undo the last back-fill | Puts back the lines of the last back-fill. |

To keep one note out, add the property `task-date-links: false` to it. The plugin then adds no link on completion there. Every back-fill skips the note and counts it in the preview and the final notice. Only the boolean `false` counts, not the quoted text `"false"`.

A link that you delete by hand is not added again in the same session.

## Pro

The free version has no time or task limit.

Pro adds the two features marked Pro above. To get it:

1. Sponsor [theluckystrike on GitHub Sponsors](https://github.com/sponsors/theluckystrike) with $5 a month, or $15 once. When you have paid $15 in total, Pro stays on.
2. In Obsidian, open the settings of Task Date Links and select "Sign in with GitHub".
3. Paste the code the plugin shows at github.com/login/device and approve.

If you sponsor after you sign in, select Refresh. If a monthly sponsorship ends before you have paid $15 in total, Pro turns off at the next check, within 7 days.

## Settings

| Setting | What it does |
| --- | --- |
| Pro | Sign in, status, Refresh and Sign out. |
| Link a task when it is completed | On by default. |
| Daily note format | A moment format. Empty means the format of the Daily notes plugin. |
| Link text format | An optional moment format for the text after the pipe. |
| Remove the link when a task is reopened | On uncheck, removes a link that the plugin added in the same session. |
| Start, scheduled, due and created date | Pro. Link these dates of a completed task. |
| Weekly and monthly note | Pro. Link the week or month of each linked date, with a format for each. |
| Only these folders, Skip these folders | Pro. One folder for each line. |

## FAQ

### Do I need the Tasks plugin?

No. Task Date Links reads the done date in the note. Tasks is the usual source, and a date that you type by hand also works.

### Will it break my tasks?

The tests run with the real Tasks plugin. They check emoji fields, Dataview fields, recurrence rules, block ids and Windows line endings, and Tasks reads each line after the link is in it.

### Do my Tasks queries still work?

Queries on dates, status and priority work as before, because the fields do not change. The description of the task now holds the link text. A query such as `description includes 2026` sees it.

### What happens if I uninstall the plugin?

The links stay in your notes as normal links.

### Does it work on a phone or tablet?

Yes. It uses no desktop-only feature.

## Payment, account and network

The core features are free and stay free. Pro features need a GitHub Sponsors sponsorship of theluckystrike: $5 a month or more, or $15 once. When you have paid $15 in total, Pro stays on. Your notes stay readable and editable with or without Pro.

GitHub handles the payment. Sponsor at https://github.com/sponsors/theluckystrike. You need no account for the free features. Pro needs the GitHub account that sponsors.

Until you select "Sign in with GitHub" in the settings, Task Date Links makes no network requests. Sign in uses the GitHub device flow. Task Date Links sends its public client ID and the scope `read:user` to `https://github.com/login/device/code` and shows you a code. While you enter the code at https://github.com/login/device, it asks `https://github.com/login/oauth/access_token` every few seconds whether sign in is done. The scope `read:user` is read-only access to your profile, which GitHub needs to show the sponsorship tier. It gives no access to repositories and no write access.

After sign in, Task Date Links sends one query to `https://api.github.com/graphql`: does the signed-in account sponsor theluckystrike, at which tier, and how much it has paid theluckystrike in total. It asks again at most once every 7 days, or when you select Refresh. It sends no note content, file names or other vault data, and it has no telemetry.

Pro keeps working for 14 days without a successful check. The GitHub token stays in the secret storage of Obsidian on this device. It is not written to data.json or other vault files, so it does not sync or reach a git repository. The local storage of this device keeps your GitHub login, the tier and the time of the last check. Sign out deletes the token. You can also revoke the access in your GitHub settings, under Applications.

## Support

Report a bug or ask for a feature in the issue tracker of this repository. To support the work, use [GitHub Sponsors](https://github.com/sponsors/theluckystrike).

```
npm ci
npm run build
npm test
```

## License

MIT
