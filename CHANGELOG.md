# task-date-links

## 1.2.1

### Patch Changes

- The Pro notice for the vault back-fill now has a Sponsor on GitHub button.

## 1.2.0

### Minor Changes

- After a minor or major update, Task Date Links opens one What's new tab in the background. The tab and settings card suggest other NoteMods plugins and Zovo Chat and link to notemods.com for feedback ([privacy](https://notemods.com/privacy/)). The tab sends no data. Turn the tab off in Settings. Add the Send feedback command. The plugin makes no new network requests.

## 1.1.3

### Patch Changes

- b0b08cb: Keep outstanding undo entries for retry and reload, bound back-fills to recovery capacity, reject overlapping mutations, stop later note writes after disable, and hand off recovery and ordered settings saves across immediate re-enable, retrying failed recovery saves before a fresh enable becomes ready.

## 1.1.2

### Patch Changes

- 85e6f8b: Treat a GitHub sponsorship reply without an amount as a failed check, not a refusal, and stop the GitHub sign in when the settings close or the plugin unloads.

## 1.1.1

### Patch Changes

- e6438e3: Skip task lines in a code block inside a callout or a list item, and keep the other notes and the undo of a back-fill when one note cannot be written.

## 1.1.0

### Minor Changes

- f699110: Add free daily note folder links with the core folder, a folder override and date link text.

## 1.0.2

### Patch Changes

- efdff8f: Correct the GitHub Sponsors payment, check and token storage text in the README.

## 1.0.1

### Patch Changes

- 2c135d9: The back-fill of a note, a selection and the whole vault now skips a note with the property `task-date-links: false`, and the preview and the final notice say how many notes it skipped.
