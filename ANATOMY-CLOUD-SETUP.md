# Anatomy labelling: sign-in and cloud save

The anatomy quiz editor (`?dev=1` on any `*-anatomy-quiz.html` page, opened from
`anatomy-labelling.html`) can save your labelling to your Google account, so you can
outline structures on an iPad, carry on from a laptop, and have the quizzes use the
outlines immediately, with no files to download or replace.

It uses the Firebase project that the review pages already use (`give-a-paw`, Realtime
Database in the US). Three one-time steps in the
[Firebase console](https://console.firebase.google.com/project/give-a-paw) switch it on.

## 1. Turn on Google sign-in

**Build → Authentication → Sign-in method → Add new provider → Google.** Enable it,
choose your support email, and press **Save**.

Under **Authentication → Settings → Authorized domains**, check that `localhost` and
`giveapaw.github.io` are listed (both were added for the review pages).

## 2. Publish the database rules

**Build → Realtime Database → Rules.** Replace everything with the contents of
[`database.rules.json`](database.rules.json) and press **Publish**. The `sessions` part
is unchanged; the new `anatomy` part does this:

- `anatomy/pages/<page>`: the saved labelling for each quiz page. Anyone can **read**
  it, because the public quizzes play from it. Only approved editor accounts can
  **write** it, and every save must carry the writer's own account ID.
- `anatomy/backups/<page>/<date>`: one automatic restore point per page per day (the
  copy as it was before that day's first save). Only editors can read these, and an
  existing restore point can never be overwritten.
- `anatomy/editors/<account ID>`: the approved accounts. Nobody can add themselves:
  you add entries by hand in the console (step 3).

## 3. Approve your account (once)

1. Open `anatomy-labelling.html` and press **Sign in with Google**.
2. The page says the account "cannot save yet" and shows its ID
   (`anatomy/editors/<long ID>`).
3. In the console: **Realtime Database → Data**. Hover over the top line (the database
   URL) and press **+**.
   - Name `anatomy`, then press the **+** beside it to add a child.
   - Name `editors`, then press **+** beside that.
   - Name: paste the ID. Value: `true`. Press **Add**.

   Do not use **Import JSON** on the top line: it would replace the whole database,
   including live review sessions.
4. Reload the hub. It now says "Signed in as ... Your labelling saves to your account."

To let someone else help, have them sign in, then add their ID the same way.

## Using it on an iPad

The iPad needs the site on the web, so this works once the pages are published to
`https://giveapaw.github.io/`. Then:

1. Open `https://giveapaw.github.io/anatomy-labelling.html` in Safari and sign in.
   Sign-in is remembered on that iPad. *Share → Add to Home Screen* gives it an icon.
2. Press **Label** on a set. On an iPad the editor fills the screen:
   - **Top bar:** set menu, the structure you are on, and the save status.
   - **Bottom bar:** List, previous/next, Trace, Finish, zoom, Undo.
   - **Corner:** the labelled textbook figure. Tap it to enlarge it, or use
     **Reference** to hide it.
3. Tap **Trace**, then tap around the structure's outline. Tap the gold first point or
   **Finish** to close it. The next unlabelled structure starts automatically.
   - **Zoom and move:** pinch to zoom; drag with one finger to move around.
   - **Fix a point:** touch it, then press **Delete point** (or drag it to a new spot).
     Drag a blue dot to add a point.
4. The top bar shows **Saving...**, then **Saved to your account**. Work is also kept on
   the iPad, so nothing is lost if the connection drops; it uploads when you are back
   online and signed in.

## Two devices at once

Each save checks that nobody saved the same page in between. If the laptop saved after
the iPad loaded the page, the iPad shows **Changed on another device · Load it** instead
of overwriting. **Load it** reloads with the newer copy and offers your unsent work back
as a draft (Restore it / Discard it).

## The quiz side

Every quiz page reads the saved copy and plays it when it is newer than the page's
`quiz-data-*.js` file. Structures that have not been outlined or placed yet are left out
of the quiz. A set with none shows "No structures in this set have been labelled yet."

## Copying the labelling into the site files

The site works from the cloud copy alone. To bring the files in line, for example
before a release or as a backup in git, run:

```bash
python tools/anatomy/pull_cloud.py
```

It rewrites each `quiz-data-*.js` whose cloud copy is newer and stamps the file with the
same save time. Add `--dry-run` to only list the changes. The editor's **Download data
file** button still works too; a downloaded file counts as newer than the cloud copy.

## Restoring an older version

In the console, open `anatomy/backups/<page>/<date>`, copy its `json` value into
`anatomy/pages/<page>/json`, and set `anatomy/pages/<page>/savedAt` to the current time
in milliseconds.
