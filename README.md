# Smart Checkpoints Server

The Smart Checkpoints server. It holds the checkpoint graph, records sightings,
asks distance drivers how far apart two checkpoints are by road, and turns edge
distance and elapsed time into violations.

It also serves the operator console, which lives in [`console/`](console) and is
built into `public/`.

The documentation is not here. It is a Mintlify site at
[docs.smartcheckpoints.xyz](https://docs.smartcheckpoints.xyz), built from the
`docs` repository, and it is the only place this system is documented.

## Stack

Node, Express, SQLite, Socket.IO for browsers and raw `ws` for distance drivers.
The console is Next.js, TypeScript and Tailwind, exported to static files: the
same stack and the same design system as
[smartcheckpoints.xyz](https://smartcheckpoints.xyz).

## Run it

```bash
npm install
npm run build
npm start
```

Then open <http://localhost:3000>.

`npm run build` builds the console into `console/out`, which Express serves
directly. The API and both realtime channels work without it; only the browser
pages are missing, and they say so.

`console` is an npm workspace of this package, so the single `npm install`
above installs its dependencies too.

Requires Node 20 or newer.

```bash
npm run build          # build the console
npm start              # run the server
npm run console:dev    # Next.js dev server for the console, UI work only
npm run console:lint   # eslint over the console
```

<sub>`npm run console:dev` serves the pages on their own port with hot reload.
Its API calls will not resolve, because the console talks to whatever origin
serves it. For anything touching data, `npm run build` and reload.</sub>

## Configuration

Copy `.env.example` to `.env`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | Port for the API, the console, and both realtime channels. |
| `HOST` | `127.0.0.1` | Interfaces to listen on. Loopback by default: nothing else on the network can reach the server. Set `0.0.0.0` for cameras and drivers. |
| `ADMIN_PASSWORD` | *(none)* | Guards `/admin`. **Unset switches administration off entirely.** |
| `WIFI_ADAPTER_NAME` | *(none)* | Adapter whose IPv4 address is printed at startup, so cameras on the same network know where to report. |

`/admin` lists every project together with its API key, and a project API key is
full read and write on that project. Set `ADMIN_PASSWORD` to something real on
any server that is reachable by anyone else.

The server prints which mode it started in. Loopback says so and says what to
set; open says so and prints the address cameras should report to.

## Access control

Two kinds of key, because a camera is not a console.

| Role | Held by | Can do |
| --- | --- | --- |
| `operator` | the console, administrators, the distance driver | everything, on its own project |
| `reporter` | one camera each | `POST /report-checkpoint`, for its own project |

A project's key - the one `/create-project` returns and `/admin` lists - is its
operator key, and is unchanged. Reporter keys are issued per camera, from the
project panel in the console or over REST:

```
POST   /project/:id/reporter-keys           { "label": "Corniche east" }
GET    /project/:id/reporter-keys
DELETE /project/:id/reporter-keys/:keyId
```

All three need the project's operator key. An issued key is returned once and
never again; the list gives back a six-character prefix, enough to match a key
to a camera and revoke the right one. A lost key is revoked and reissued.

Why the split: a project key is held by the console, by the distance driver and
by every camera in the field, and a camera is a box on a pole that somebody can
open. A key lifted off one should not be able to read the graph, rewrite the
distance and speed limit a violation is calculated from, or read the violation
records - so it cannot. Every project-scoped endpoint also checks that the row
it is about to touch belongs to the project the key opens. That is containment,
not multi-tenancy: one server holds one organisation's projects.

Cameras still send their key in an `x-api-key` header over plain HTTP. On a
dedicated VLAN that may be fine; on shared wifi it is a key anyone on the
network can read off the wire. A reporter key is much less costly to expose
than an operator key, which is most of the reason the split exists.

## Distance and enforcement

An edge enforces nothing until somebody has said how long it is. Which of those
two an edge is in, is a column rather than an inference:

| `distance_status` | Meaning | Violation checks |
| --- | --- | --- |
| `ok` | A driver routed it, or an operator typed it | Run normally |
| `unknown` | Nobody has answered, or a driver failed | **Skipped.** Shown as not enforced |
| `no-route` | A driver says there is no road here | **Skipped.** Flagged as a data error |

`connections.distance` is NULL whenever the status is not `ok`, and a distance
of zero is rejected on the way in. Both the violation path and the congestion
loop skip an edge whose status is not `ok`, and the console draws those edges
with a broken stroke - dashed for `unknown`, dotted for `no-route`.

This used to be one column doing two jobs. A driver that failed wrote `0`, the
maximum traversal time came out at zero, and no car was ever slower than it, so
the road silently stopped enforcing - the right outcome, but as an accident of
the arithmetic rather than a decision. Anyone who later "fixed" that zero with a
straight-line estimate would have switched enforcement back on with numbers
nobody had checked. The status makes the skip deliberate and the estimate
unnecessary.

Existing databases migrate on first start: a stored distance above zero becomes
`ok`, and every zero becomes `unknown` with the distance nulled, to be
recalculated when a driver next connects.

## The driver channel

Drivers connect to `/distance-driver`, a raw WebSocket on the same port as
everything else. Socket.IO on this server is for browsers only.

The server knows nothing about routing or maps. It asks a question and stores an
answer, and there is no code anywhere in it that branches on which driver is on
the other end - which is what makes an eleventh distance driver cost nothing.

**Protocol v2.** A driver that names no `protocolVersion` is v1 and keeps
working exactly as it did.

```jsonc
// driver -> server
{ "type": "auth", "apiKey": "...", "protocolVersion": 2, "role": "distance",
  "driverName": "osrm", "capabilities": { "geometry": true } }
// server -> driver
{ "type": "authenticated", "projectId": 1, "protocolVersion": 2 }
```

`role` is `distance` or `map`, and defaults to `distance`. Capabilities are
additive and optional: they are logged and never gate anything. The version in
the reply is the one the server will actually speak - the lower of the two.

A **map driver** authenticates the same way and is then never asked anything. It
adds one field, `uiUrl`, naming the address of its own map page - see
[The map view](#the-map-view). Holding the socket open is its whole function:
the map view exists exactly while it is connected.

**One driver per role per project.** A second driver claiming an occupied slot
evicts the first, which is closed with code `4001` and the reason
`"replaced by a newer driver"` so a duplicate started by mistake fails at the
machine that started it rather than sitting there connected and idle.

**Requests carry both the indices and the coordinates**, always, so the server
never has to know which protocol version it is talking to:

```jsonc
{ "type": "calculate-distance", "requestId": "...",
  "fromIdInProject": 0, "toIdInProject": 1,
  "from": { "latitude": 31.2001, "longitude": 29.9187 },
  "to":   { "latitude": 31.2054, "longitude": 29.9245 } }
```

**Results may carry geometry.** `path` is a GeoJSON `LineString` in WGS84,
coordinates `[longitude, latitude]`, and it is optional: distance is what
enforcement runs on, geometry is what a map view draws. The server stores it as
a string without reading it - it checks only that it is a LineString in that one
format and under 256 KB, and keeps the distance while dropping anything that
fails. `endpointOffsets` is how far each requested coordinate was from the road
the driver routed on; it is stored for the diagnostics work to come.

**Failures are a message**, not silence. `{ "type": "distance-error",
"requestId": "...", "code": "no-route" | "unavailable" | "invalid-input" }`.
`no-route` sets `distance_status` to `no-route` and is not retried; the other
two set `unknown` and are retried on the next reconnect, and `invalid-input` is
logged loudly because it means this server sent something unusable.

Silence is treated differently from any of those. A request that times out, or
dies with its socket, leaves the edge exactly as it was: nobody has said
anything about that road, and a distance that was right an hour ago is still the
best thing known.

**A connecting driver is asked only about what has changed.** Authenticating
used to trigger a routing request for every edge in the project, every time.
Now an edge is only asked about if one of three things is true:

- its `distance_status` is not `ok`;
- one of its checkpoints has moved since the distance was worked out;
- it has no route geometry and this driver declares `capabilities.geometry`.

"Has moved" is a stored `sha256` of the two positions the distance was measured
between, written whenever a distance is decided - by a driver or by an operator
typing one. A driver restarting on a project whose distances are all current
sends nothing at all, and each run logs what it considered, what it found stale
and why, and what it recalculated.

An edge stored before this fingerprint existed has none, which reads as moved,
so an upgraded database recalculates once and is quiet after that.

**The socket is kept honest.** A connection that does not authenticate within
ten seconds is closed. Every driver is pinged every thirty seconds and
terminated after two go unanswered, so a driver killed outright frees its
project's slot in about ninety seconds rather than whenever TCP notices, and
every request it still owed an answer for is failed immediately rather than left
on the thirty-second timer.

## Data quality

A camera reports where it thinks it is, and nothing downstream questions it. A
bad GPS fix therefore does not fail: it produces enforcement measured between
the wrong two points, and the violation that comes out is indistinguishable
from a real one. `GET /project/:id/diagnostics` is where that difference
becomes visible. It needs the project's operator key and checks the key against
the project in the path, like every other project-scoped read.

Three signals, computed from data the system already holds - node
positions, road distances, and the offsets a driver reported between the
coordinates it was given and the road network it routed on - and one aggregate
over them:

| Flag | On | Means |
| --- | --- | --- |
| `off-network` | a checkpoint | A driver reported this coordinate more than 150 m from the nearest road it could route on |
| `impossible` | an edge | The road is shorter than the straight line - swapped coordinates, wrong units, or a broken driver |
| `circuitous` | an edge | The road is at least 2.5x the straight line, on an edge at least 250 m long |
| `suspect-position` | a checkpoint | At least two thirds of this checkpoint's judgeable edges are circuitous, and there are at least three of them |

The last row is the one that matters. A single circuitous edge is almost always
real geography - a river with a distant bridge, a rail corridor, a one-way
system - and flagging per edge produces false positives forever. A checkpoint
with a bad fix inflates *every* edge that touches it, so the fraction is what
separates a misplaced camera from an awkward junction, and it points at the
thing an operator can actually fix.

The 250 m floor matters as much. Two cameras on opposite sides of a divided
road can be 30 m apart with a 400 m drive to the nearest U-turn; a circuity of
27 there is entirely correct, and judging it would flag every dual carriageway
in the city.

Every flag comes back with the numbers behind it - circuity, displacement, road
distance, endpoint offsets - and with the thresholds it was judged against,
because a flag the operator cannot interrogate is a flag they will learn to
ignore. The thresholds themselves are in one block at the top of
`diagnostics.js`, and they are guesses: educated starting points from how road
networks generally behave, not values tuned against a real deployment.

Nothing is stored. It is a few milliseconds of arithmetic over rows already
being read, and the moment a checkpoint moves every number in it is wrong.
The console recomputes it when the panel is opened and when the operator asks.

## Correcting a checkpoint's position

Diagnostics say which camera is in the wrong place; `PUT /node/:id` is how it
gets moved. Body `{ latitude, longitude }`, WGS84 degrees, validated by the
same two functions `create-node` uses. `:id` is a node id rather than a
project id, so the ownership check is inside the handler rather than in
middleware - a key may only move its own project's checkpoints.

Moving a checkpoint throws away every distance measured to it:

1. The position is updated.
2. Every edge touching it loses its `distance`, its `distance_status`, its
   `path`, its `endpoint_offsets` and its `endpoints_hash`.
3. If a driver is attached, those edges are measured again - they are
   unresolved now, which is exactly what the staleness rule already looks for.
4. `node-moved` goes out over Socket.IO, followed by a `connection-updated`
   for each edge that just stopped enforcing.

Step 2 is the point of the endpoint. The stored distance was measured between
two positions, one of which has just changed; keeping it would enforce a road
length that no longer corresponds to anything, and every violation it produced
would look exactly like a real one. An edge with no distance enforces nothing,
and says so on the canvas, which is the correct state until a driver answers.

A move to the coordinates a checkpoint already has changes nothing and
invalidates nothing, so a retried request after a lost reply is free.

In the console, shift-drag a checkpoint across the graph. The graph is
geometrically faithful, so the drop point is a real position, and the drag is a
proposal rather than a write: the dialog says how far the camera would move in
metres and how many connections stop enforcing, and nothing is sent until that
is agreed. An accidental drag must not quietly change what counts as speeding.

## The map view

The console has two views of the same graph. The **graph view** draws straight
lines on a blank background: core-owned, always available, needs no driver, and
the only one that edits. The **map view** is an `<iframe>` pointing at a map
driver's own page, drawing the road shapes a distance driver measured on a real
basemap.

They draw the same geometry, which is what makes the toggle diagnostic: a
checkpoint that looks fine on the graph and sits inside a building on the map
has told you something. The graph is the fallback whenever the map is not there,
and there is nothing to dismiss when it goes.

The frame is somebody else's page in somebody else's process, so the console
cannot see it fail: a driver whose socket is up but whose HTTP port is not
reachable from the browser produces an empty frame and no error anywhere. If no
handshake arrives, the console says so over the frame and names the address.
Everything after the handshake is the map driver's own to explain, and
`driver-mapbox` does.

The server never imports a mapping library and never learns whether the map is
Mapbox, Leaflet or anything else. `driver-mapbox/` is a reference
implementation of one.

**Geometry is served separately.** `GET /project/:id/geometry` returns
`{ connection_id, path, path_format }` for the edges that have geometry, and the
console reads it only once something is drawing a map: it is up to a quarter of
a megabyte an edge, the graph view draws none of it, and most sessions never
open a map. `path` goes out as the text the driver sent, inside a JSON string,
because the server does not parse route geometry - decoding it to re-encode it
would be reading it.

### Announce, then approve

A map driver names its own UI address when it authenticates. That address ends
up in an iframe inside the console's own chrome, so whoever holds a project API
key would otherwise be choosing what renders there. A cross-origin frame cannot
read the console - but it is handed every checkpoint, distance and violation in
the project, and it could paint a convincing fake console around them.

So an announcement is a proposal:

| Status | Meaning |
| --- | --- |
| `none` | Nothing announced, or approval withdrawn. Graph view only |
| `pending` | A driver named an address nobody has agreed to. Not embedded |
| `approved` | An operator approved this address. The only status that renders |

The announced address lands in `pending_map_driver_url`, and an operator
approves it once, under **Project** in the console. Approving names the address
being approved, so a driver that re-announced something else between the screen
being drawn and the button being pressed gets a 409 rather than an approval
nobody read.

Reconnecting on the same address stays approved - restarting a driver does not
send anybody back to the approval screen. Announcing a **different** address
goes back to `pending` and drops the previous approval, which described a page
that is no longer being served.

`GET /project/:id/map-driver` reads the state; `approve`, `reject` and
`revoke` under the same path are the three decisions. Every one of them, and
every connect and disconnect, broadcasts `map-driver-status` to the project's
console tabs.

### The bridge

The console holds the single Socket.IO connection and forwards state into the
frame with `postMessage`. The map driver never opens a socket to this server,
never talks to the distance driver, and never holds an API key.

Every message is `{ v: 2, type, payload }`. **Both sides pass the other's origin
as `targetOrigin` - never `"*"` - and check `event.origin` on receipt.** The
frame carries `sandbox="allow-scripts allow-same-origin"`, and
`referrerpolicy="origin"` so the page can learn which console embedded it and
nothing else about the URL. A frame whose approved origin is the console's own
is refused outright: `allow-same-origin` would leave it not isolated from the
console at all, and a map driver serves its page from its own process.

Console to frame: `sc:init`, `sc:graph`, `sc:node-updated`, `sc:edge-updated`,
`sc:congestion`, `sc:diagnostics`, `sc:selection`. Frame to console:
`sc:ready`, `sc:select`, and `sc:node-moved` from a driver that declared
`capabilities.nodeDrag`. The contract is typed in `console/src/lib/mapbridge.ts`
and spelled nowhere else in the console.

Everything arriving from the frame is validated at runtime - shape, coordinate
ranges, everything - because a TypeScript type is a claim about this code, not a
check on somebody else's. A message that fails is dropped without a word.

`sc:node-moved` takes exactly the path a shift-drag on the graph takes: the
same confirmation, in metres, and the same endpoint. Dragging a checkpoint on a
basemap is where a bad GPS fix becomes obvious, so it is worth supporting, but
the map proposes and the console decides.

## Layout

```
server.js                   the HTTP API, Socket.IO, and the driver WebSocket
database.js                 schema, migrations, and every SQL statement
geo.js                      projection and coordinate validation
diagnostics.js              the data-quality signals and their thresholds
api-key-manager.js          key generation and the auth middleware

console/                    the operator console, a Next.js static export
  src/app/globals.css       the design tokens, shared with the web repository
  src/app/page.tsx          the project list
  src/app/project/page.tsx  the live checkpoint graph
  src/app/admin/page.tsx    the project table
  src/components/ui/        the shared component system
  src/components/console/   the graph canvas, its panels and its dialogs
  src/lib/api.ts            every REST call the console makes
  src/lib/realtime.ts       the Socket.IO channel, typed
  src/lib/mapbridge.ts      the postMessage contract with a map driver
  src/lib/geo.ts            the browser half of geo.js

  out/                      the build, served directly by Express
                            generated, and not in version control

database.db                 SQLite, created on first run
```

## Conventions

These hold across the server, the console, and every distance driver.

- Coordinates are WGS84 latitude and longitude in degrees. Always.
- Distances are metres. Speeds are km/h. Always.
- Timestamps written to the database and sent over the wire are ISO 8601 in UTC.
- Request bodies are kebab-case, rows come back snake_case. That asymmetry is
  part of the published wire protocol, so it is preserved rather than tidied,
  and the console contains it in one file.
- An unresolved distance is NULL, carries a `distance_status` saying why, and
  enforces nothing. The server never substitutes a straight-line estimate for a
  road distance a driver could not answer: a missing distance is an obvious
  gap, and a plausible wrong one is an invisible fault that produces violations
  indistinguishable from real ones.

## License

MIT.
