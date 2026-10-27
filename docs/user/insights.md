# Insights

Insights estimates how much coding work your team pushes and lands each week, per person, from
the GitLab projects on this server. Open it from **Insights** in the sidebar or the command
palette.

Every number is a model estimate of coding output, not hours worked. Read the numbers as a team
trend. Do not rank or judge individuals by them.

Only administrators see Insights. Operators and Readers do not see the page, the sidebar entry,
or the settings section.

## What the page shows

Pick a window of the last 4, 8, 13, or 26 weeks, or a custom range. You can narrow the page to
some of the people Insights covers.

- **Team trend.** Weekly bars of pushed and landed hours per active person, with the landed
  share to date as a line: landed hours over pushed hours from the start of the window.
- **Contributor table.** Landed hours, pushed hours, landed share, throughput, commits, merge
  requests merged, reviews given, median time to first review, and median cycle time. Click a
  column heading to sort by it.

Pushed hours count commits by the day they were written. Landed hours count commits by the day
they reached the default branch, or a release branch you name in settings. A merge request's
commits land when it merges. Commits that a rebase replaced count once.

Throughput is pushed hours divided by eight hours per working day in the window. A value of 1.0
means one full-time engineer's worth of estimated coding output.

Reviews are comments and discussion threads on someone else's merge request. GitLab approvals
are not counted yet.

## Set up Insights

Insights reads merge requests through the GitLab CLI sign-in this server already uses for pull
requests, and reads commits from each project's checkout. If a project shows a sign-in error,
run `glab auth login` on the server. See [Source control](./source-control.md#gitlab).

1. Open **Settings > Insights**.
2. Set the **Start date**. Insights never asks GitLab or git for anything older than this day.
3. Turn on the projects you want covered. Only projects whose remote is GitLab are listed, and
   each one starts turned off.
4. Wait for the first sync. People appear under **Pending** as Insights finds their merge
   requests, commits, and comments.
5. Include the people you want measured. Exclude the rest.

Insights stores nothing about a pending or excluded person except their name, GitLab username,
and commit email. When you include someone, Insights reads the covered projects again from the
start date to fill in their history. Excluding someone deletes what Insights stored about them.
Turning a project off deletes what it stored for that project.

## Things to know

- **One person, two entries.** A commit email that Insights cannot match to a GitLab username
  shows up as its own pending entry. Use **Merge into…** to fold it into the right person.
- **Agents and bots.** Set an entry's kind to agent or bot to keep that work in its own row.
- **Moving the start date.** An earlier date reads the gap on every covered project. A later date
  keeps what is already stored.
- **Sync pace.** Insights spends a fixed number of GitLab requests per host every few seconds,
  set by **Requests per tick**, and shares the pause T3 Code takes when GitLab rate-limits it. A
  large project can take a while to catch up. **Rescan** reads one project again from the start
  date.
