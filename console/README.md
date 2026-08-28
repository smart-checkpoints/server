# Smart Checkpoints Console

The Smart Checkpoints operator console: the project list, the live checkpoint
graph, and the project table.

It is a Next.js app exported to static files. Nothing here runs on a Next.js
server. Every page talks to the Smart Checkpoints REST API and Socket.IO channel
from the browser, on the same origin, and the export is served by the Express
process in the parent directory.

Build it from the server directory:

```bash
cd .. && npm run build
```

That runs `next build` here and copies `out/` into `../public`. Building here
directly with `npm run build` produces `out/` and leaves it there.

`npm run dev` serves the pages with hot reload for UI work. Its API calls will
not resolve, because the console talks to whatever origin serves it. For
anything touching data, build and reload.

## The design system is shared, not forked

The tokens, the type scale, the component system and the brand marks are the
same ones [smartcheckpoints.xyz](https://smartcheckpoints.xyz) runs on. These
files are the web repository's, copied here because the two live in separate
repositories with no package registry between them:

```
src/app/globals.css          tokens, type scale, buttons, scrollbars
src/lib/cn.ts                class joining
src/lib/motion.ts            the one curve and the one scroll gesture
src/components/LogoMark.tsx  the mark and the wordmark, drawn not loaded
src/components/ui/Badge.tsx
src/components/ui/Button.tsx
src/components/ui/Card.tsx
src/components/ui/Container.tsx
src/components/ui/Reveal.tsx
src/components/ui/SectionHeading.tsx
src/app/icon.svg, favicon.ico, apple-icon.png
```

Change any of them in the `web` repository first, then copy the change here.
`globals.css` is identical to the web copy down to its `CONSOLE` section, which
holds the form controls and canvas chrome a marketing site has no use for.

`Nav.tsx` and `Footer.tsx` are built to the same specification but carry the
console's own links and an action slot, so they are not copies. `Section.tsx` is
not carried over at all: it draws the alternating full-width bands of a
marketing page, and the console has none. Copy it across the day one is needed.

## What is specific to the console

```
src/lib/api.ts          every REST call, and the only file that knows the
                        wire protocol's kebab-case request bodies
src/lib/realtime.ts     the Socket.IO channel, with its events typed
src/lib/session.ts      where the project API key is held, and why
src/lib/geo.ts          the browser half of the server's geo.js
src/lib/tokens.ts       the CSS tokens, read at runtime for canvas code
src/lib/format.ts       every number and time the operator reads

src/components/console/ the graph canvas, its panels and its dialogs
```

## Conventions

- Coordinates are WGS84 degrees, distances are metres, speeds are km/h. The
  console converts nothing; it formats.
- Colour means one thing. Cyan is structure. Green, yellow and red are status,
  and are never decoration.
- The project API key lives in `sessionStorage` and travels in the `x-api-key`
  header. It is never put in a URL and never rendered unmasked without a
  deliberate act.
