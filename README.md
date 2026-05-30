# Dreaming

A nightly morning-report app for [Möbius](https://github.com/mobius-os). While you sleep, a sub-agent reads what you did the previous day across your Möbius — apps you opened, chats you had, things you installed — and writes a one-page HTML report. Open Dreaming in the morning to read it.

Quiet days don't get a fabricated report. If you didn't do anything meaningful, the dreamer takes the night off and your streak resets to zero.

## Install

### Via the App Store (recommended)

Open the **App Store** mini-app in Möbius, search for "Dreaming", tap **Install**.

### Via paste-a-URL

In the App Store, choose **Install from URL** and paste:

```
https://raw.githubusercontent.com/mobius-os/app-dreaming/main/mobius.json
```

Möbius will fetch the manifest, show you the requested permissions and schedule, and install with one tap.

## Customize

Everything is editable from the **Settings** tab inside the app:

- **Editorial brief** — what the dreamer should notice, what to weight, what to skip. This is the highest-leverage knob. Write it in your own voice.
- **Verbosity** — terse, standard, or chatty. Standard is a few paragraphs with 2–4 suggestions and a closing observation.
- **Agent / Model** — Claude or Codex; pick any model from a connected provider.
- **Dream time** — when the cron fires. Defaults to 06:00 UTC (with your local equivalent shown). Tick "use my local time" if you'd rather pin to your wall clock and let DST handle itself.

Schedule changes take effect within 10 minutes (the cron sync runs every 10).

The **Reports** tab lists every dream the dreamer has written, newest first. Tap a card to expand. The body and tl;dr render with DOMPurify sanitisation; an injected stylesheet handles typography.

## How it works

A small `fetch.sh` cron job runs at your chosen time. It:

1. Pulls the last 24h of activity from `GET /api/admin/activity` (gracefully degrades if that endpoint isn't deployed — the dreamer falls back to chats-only signal).
2. Pulls recent chats from `GET /api/chats/` and a few messages from each.
3. Reads its own last 7 days of reports so it doesn't repeat itself.
4. Composes a prompt: system schema + your editorial brief + yesterday's context + recent dreams.
5. Invokes Claude (or Codex) with **no tools** — the whole context is already in the prompt; there's nothing left to fetch.
6. Parses an `<article class="dreaming-report">` block from the reply and PUTs it to `reports/YYYY-MM-DD.html`.
7. Updates `streak.json` — increments if yesterday was also an active day, resets to 0 on night-off.
8. Sends a push notification with the tl;dr.

The service token is held by `fetch.sh` and never enters the agent's prompt, so a prompt-injection in a chat snippet has nothing to exfiltrate and no shell to run.

## Streak

The streak counts consecutive days the dreamer found meaningful Möbius activity to write about. A "no activity today" night resets it to zero; the next active day starts at 1. Same-day re-runs (using "Run dreamer now" multiple times) don't double-count.

This is deliberately not a "consecutive days the app ran" counter — that would reward leaving Möbius open, not engaging with it.

## License

MIT — see [LICENSE](LICENSE).
