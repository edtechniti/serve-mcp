# serve-delivery-mcp

An [MCP](https://modelcontextprotocol.io) server that lets AI assistants quote, dispatch and track sidewalk delivery robots through the [Serve Robotics](https://www.serverobotics.com) AV Delivery API.

> **Independent project.** Not affiliated with, endorsed by, or sponsored by Serve Robotics. Built only from Serve's public API reference. Fees and ETAs in mock mode are invented.

```
You:     Send two coffees from Corner Cafe to Alex at 200 Spring St.
Claude:  A robot can do that for $4.07, arriving in about 13 minutes. Book it?
You:     Yes.
Claude:  Dispatched. The robot is heading to the cafe now.
```

## Why it's built this way

Letting an agent act in the physical world is mostly a guardrails problem. This server enforces the important rules in code instead of trusting the model to follow them:

| Guardrail                          | How                                                                                                                                                                                     |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The human approves every price** | Dispatching takes a two-step flow, and `dispatch_robot` requires an existing `quote_id` plus `confirmed: true`. Serve's one-step instant-dispatch endpoint is deliberately not exposed. |
| **Hard spending cap**              | `SERVE_MAX_FEE_CENTS` (default $15) is checked against the fee Serve returned, not anything the model says.                                                                             |
| **No address swaps**               | Pickup and dropoff are bound to the quote on the server side. The model can't dispatch to an address that wasn't priced.                                                                |
| **No duplicate dispatches**        | Job creation is never retried blindly. If a response is lost, the server looks up the order before reporting an error.                                                                  |
| **Production needs two switches**  | Both `SERVE_ENV=production` and `SERVE_ALLOW_PRODUCTION=true`.                                                                                                                          |
| **Unlock is explicit**             | Tracking output never includes the bin unlock code.                                                                                                                                     |
| **No leaked secrets**              | Credentials come only from the environment and are redacted from all logs. Logs go to stderr, because stdout carries the MCP protocol.                                                  |

## Tools

| Tool                         | What it does                                                 |
| ---------------------------- | ------------------------------------------------------------ |
| `check_robot_availability`   | Counts robots on duty near a location                        |
| `get_delivery_quote`         | Gets a price and ETA for pickup → dropoff (reserves nothing) |
| `dispatch_robot`             | Turns a confirmed quote into a delivery                      |
| `track_delivery`             | Shows status, robot position and ETAs                        |
| `list_deliveries`            | Lists active or recent deliveries                            |
| `cancel_delivery`            | Cancels an unfinished delivery                               |
| `unlock_robot_bin`           | Opens the cargo bin at the dropoff                           |
| `get_delivery_route`         | Shows the planned route summary, with GeoJSON on request     |
| `simulate_delivery_progress` | _Mock/sandbox only:_ moves a delivery through its stages     |

Every tool carries MCP annotations (`readOnlyHint`, `destructiveHint`, …), so clients can tell which ones only read data and which ones act.

## Quick start (no credentials needed)

Requires Node.js ≥ 22.12.

```sh
git clone https://github.com/edtechniti/serve-mcp.git
cd serve-mcp
npm install
npm run build
npm run mock          # terminal 1: mock Serve API on http://127.0.0.1:4010
npm run inspect       # terminal 2: MCP Inspector (optional)
```

### Claude Desktop

Add this to `claude_desktop_config.json` (keep `npm run mock` running):

```json
{
  "mcpServers": {
    "serve-delivery": {
      "command": "node",
      "args": ["/absolute/path/to/serve-mcp/dist/src/index.js"],
      "env": {
        "SERVE_ENV": "mock",
        "GEOCODER_USER_AGENT": "serve-delivery-mcp (you@example.com)"
      }
    }
  }
}
```

Then ask Claude something like: _"Quote a robot delivery from 100 Main St to 200 Spring St, Los Angeles CA 90012."_

## Configuration

All settings are environment variables. See [`.env.example`](.env.example).

| Variable                   | Default         | Notes                                                                  |
| -------------------------- | --------------- | ---------------------------------------------------------------------- |
| `SERVE_ENV`                | `mock`          | `mock`, `sandbox` or `production`                                      |
| `SERVE_BASE_URL`           | per environment | Override, e.g. a different mock port. Must be https outside mock mode. |
| `SERVE_PARTNER_ID`         | `ptnr_mock`     | Required for sandbox/production                                        |
| `SERVE_API_KEY`            | —               | Required for sandbox/production; sent as `X-API-Key`                   |
| `SERVE_ALLOW_PRODUCTION`   | `false`         | Must be `true` to use production                                       |
| `SERVE_MAX_FEE_CENTS`      | `1500`          | Hard cap per delivery                                                  |
| `SERVE_REQUEST_TIMEOUT_MS` | `15000`         | Per-request timeout                                                    |
| `GEOCODER`                 | `nominatim`     | `nominatim` (OpenStreetMap) or `none` (caller supplies lat/lng)        |
| `GEOCODER_USER_AGENT`      | generic         | Nominatim's policy asks for an identifying UA with contact info        |
| `LOG_LEVEL`                | `info`          | `debug`, `info`, `warn`, `error`                                       |

Serve needs both an address and coordinates for each stop. If the assistant doesn't provide coordinates, the server geocodes the address (at most 1 request per second, per Nominatim's policy). The quote shows the address it matched so the user can catch a wrong pin before approving.

## The mock

`mock/server.ts` is an in-memory implementation of the public API contract: the same paths, payloads and error format; single-use quotes that expire after 5 minutes; the job lifecycle; and the documented error codes (`used_quote`, `couriers_busy`, `not_arrived_at_dropoff`, …). It uses only `node:http` and is what the integration tests run against.

## Development

```sh
npm run check     # typecheck + lint + format check + tests
npm test          # tests only
npm run dev       # run the MCP server from source
```

```
src/
  index.ts              entry point (stdio)
  server.ts             builds the MCP server and registers tools
  config.ts             env parsing and guards
  logger.ts             stderr logger with redaction
  serve/                typed API client, schemas, error mapping
  geo/                  geocoders
  state/                session quote cache
  tools/                one module per tool
mock/                   mock Serve API
test/                   unit and end-to-end tests (MCP client ↔ server ↔ mock)
```

## License

[MIT](LICENSE). "Serve Robotics" is a trademark of its owner and is used here only to describe compatibility.
