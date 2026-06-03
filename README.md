# Dreaming

The nightly self-improvement loop for [Möbius](https://github.com/mobius-os). While you sleep, Möbius *dreams*: a real agent wakes up with the whole night ahead of it and does the slow, deferred work the daytime agent never has time for. In the morning it hands you a one-page brief and a short conversation with a few decisions to tap through over coffee.

Quiet nights are skipped. If nothing meaningful happened, the dreamer takes the night off and your streak resets to zero.

## Install

### Via the App Store (recommended)

Open the **App Store** mini-app in Möbius, find **Dreaming**, tap **Install**.

### Via paste-a-URL

In the App Store, choose **Install from URL** and paste:

```
https://raw.githubusercontent.com/mobius-os/app-dreaming/main/mobius.json
```

Möbius fetches the manifest, shows you the requested permissions and schedule, and installs with one tap.

## What a dream does

The run is one multi-turn goal, not a single prompt. Working from the day's activity and chats, the dreamer:

1. **Interviews the agents that worked during the day.** It forks each chat (and each app sub-agent run) into a throwaway copy — reusing the same provider that did the original work — and asks what was hard, what it learned, what you'd want flagged. Your real chats are never touched.
2. **Sharpens its own skills and memory.** What it learns from the interviews gets folded back into the agent's skills (including the dreaming skill itself) and into **Mind**, the knowledge graph. Each night's dream is meant to make the next one better.
3. **Hardens your apps.** It opens each app, exercises the paths you actually use, and fixes the small, obviously-correct breakages so you wake to working apps. Anything with a judgment call is left as a proposal, not applied.
4. **Researches what you care about and proposes features**, each tied to something it observed you doing.
5. **Writes the brief and opens the morning chat.** A standalone HTML brief lands in `reports/<date>.html`; the questions live in a fresh morning chat as tap-to-answer cards. Open Dreaming to read the brief with that chat mounted underneath it.

When you answer the cards in the morning, that closes the loop: the dreamer acts on your decisions and records what your answers taught it, so tomorrow night's dream wastes fewer of your taps.

## No sandbox, by design

The dreamer runs with **full tools and a real token** — it is the agent, trusted, not a locked-down script. That is deliberate: Möbius's philosophy is *code empowers the agent; it does not police it*. Safety comes from instruction, not tool-denial — every change it makes is in `/data`'s git history and reversible, it never auto-applies anything risky (security changes with behavior impact, destructive data ops, dependency major-bumps, anything that hits paid APIs or notifies other people), and it surfaces those as proposals in the brief instead.

## Customize

From the app's **Settings** tab:

- **Verbosity** — terse, standard, or chatty.
- **Agent / Model** — Claude or Codex; any model from a connected provider.
- **Dream time** — when the cron fires. Defaults to 06:00 local (DST handled); untick "use my local time" to pin to UTC.

Schedule changes take effect within 10 minutes (the cron sync runs every 10). How the dreamer *dreams* — what it prioritizes, how it interviews, how long the brief runs — lives in the editable dreaming skill, which the dreamer revises itself as it learns what's worth doing.

## Streak

The streak counts consecutive days the dreamer found meaningful Möbius activity to dream about. A night off resets it to zero; the next active day starts at 1. It deliberately is not a "days the app ran" counter — that would reward leaving Möbius open, not engaging with it.

## License

MIT — see [LICENSE](LICENSE).
