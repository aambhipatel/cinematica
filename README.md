# CineScope

A high-performance cinematic search engine and metadata aggregation service that orchestrates real-time film intelligence, critic analytics, and historical Academy Award records.

## Architecture

CineScope acts as an aggregation and caching gateway between client browsers and external film metadata providers, backed by an in-memory historical database index.

```
Client Browser (SSR / EJS)
       │
       ▼
Express.js Application Gateway (Port 3000 / $PORT)
  ├── Security & Throttling: Helmet (CSP) + express-rate-limit
  ├── Health Probes: /healthz (Liveness) & /readyz (Readiness)
  ├── In-Memory LRU Cache: lru-cache (500 entries, 1h TTL)
  └── Static In-Memory Index: Map<IMDb_ID, Nomination[]>
       │
       ├── HTTPS (4s Timeout) ──> OMDb REST API (Primary Metadata & IMDb ID)
       ├── HTTPS (4s Timeout) ──> TMDB v3 API (External ID Match & Cast Credits)
       └── Local Dataset (O(1)) ─> oscar-nominations.json (5,115 Indexed Films)
```

### Request Lifecycle
1. **Validation & Throttling:** Parses and validates `req.query.title` (1–100 characters). Enforces IP-based rate limiting (30 requests/min on `/search`).
2. **Cache Resolution:** Checks an in-memory LRU cache using normalized query keys to resolve repeat lookups in sub-millisecond time.
3. **Upstream Ingestion:** Concurrently queries OMDb over HTTPS with a strict 4,000 ms timeout to retrieve core film records and IMDb identifiers.
4. **Entity Resolution:** Cross-references IMDb IDs against TMDB v3 endpoints to resolve media credits, poster assets, and audience vote metrics.
5. **Oscar Cross-Referencing:** Queries the pre-indexed in-memory hash map (`Map<string, Nomination[]>`) in $O(1)$ constant time.
6. **SSR Delivery:** Renders the aggregated data contract to the client via server-side EJS templates.

## Key Features

- **Multi-Source Metadata Aggregation:** Normalizes film specifications across OMDb and TMDB v3 into a unified data structure.
- **O(1) Historical Cross-Referencing:** Pre-indexes 10,568 Oscar nominations across 5,115 unique films during bootstrap, replacing $O(N)$ linear scans with sub-millisecond hash map lookups.
- **LRU Query Caching:** Eliminates redundant egress traffic and prevents upstream rate-limit exhaustion via in-memory LRU caching with a 1-hour TTL.
- **Defensive API Hardening:** Enforces explicit 4-second request timeouts and gzip/deflate compression on all downstream Axios requests.
- **Tiered Abuse Prevention:** Implements multi-tier rate limiting for global requests, search queries, and telemetry endpoints.
- **Zero-Downtime Lifecycle Management:** Provides Kubernetes-compatible `/healthz` and `/readyz` probes alongside graceful `SIGTERM`/`SIGINT` shutdown orchestration.
- **Containerized Deployment:** Includes an unprivileged, multi-stage Docker build targeting Node.js 20 Alpine.

## Changelog

### [2.0.0] - Production Hardening & Optimization

#### Performance & Scalability
- **Constructed In-Memory Oscar Index:** Replaced runtime linear array scans ($O(N \times M)$) across 10,568 nominations with an in-memory `Map<string, Nomination[]>` keyed by IMDb ID, reducing nomination lookup latency from multiple milliseconds to $< 0.1$ ms.
- **Integrated LRU Caching Tier:** Deployed in-memory `lru-cache` with a 500-entry capacity and 1-hour TTL, resolving repeat queries in sub-millisecond time and mitigating upstream API quota depletion.
- **Converted File I/O to Asynchronous:** Migrated local dataset ingestion from synchronous blocking calls to `fs.promises` to maintain event-loop responsiveness during boot.

#### Security & Compliance
- **Enforced Encrypted Transport:** Switched OMDb endpoints from plaintext `http://` to TLS `https://`, preventing credential exposure and man-in-the-middle tampering.
- **Integrated Security Headers:** Configured `helmet` middleware with a granular Content Security Policy (CSP), enforcing frame restrictions, MIME-sniffing prevention, and origin isolation.
- **Established Multi-Tier Rate Limiting:** Integrated `express-rate-limit` across three boundaries:
  - Global middleware (300 requests / 15 minutes per IP).
  - Search endpoint (30 queries / minute per IP) with dedicated 429 status rendering.
  - Telemetry endpoint (20 payloads / 15 minutes per IP).
- **Hardened Client Telemetry:** Enforced payload size constraints (`10kb` body parser limit, 200-character string truncation) and sanitized incoming messages to strip ANSI escape sequences and ASCII control characters.

#### Reliability & Resiliency
- **Configured Request Timeouts:** Bound all outbound Axios network operations to an explicit 4,000 ms timeout to prevent socket descriptor exhaustion and connection starvation.
- **Enforced Input Boundary Validation:** Added strict type-checking, trimming, and character bounds (1–100 characters) on `req.query.title`, returning immediate HTTP 400 Bad Request responses on invalid input.
- **Orchestrated Graceful Shutdown:** Registered `SIGTERM` and `SIGINT` handlers to flush and terminate active HTTP connections before process exit.
- **Added Configuration Assertions:** Implemented bootstrap environment validation to output explicit warnings when required API keys are missing.

#### Infrastructure & DevOps
- **Integrated Cloud Health Probes:** Added `/healthz` (liveness probe) and `/readyz` (readiness probe asserting database indexing and cache health).
- **Parameterized Port Binding:** Bound HTTP listener to `process.env.PORT || 3000` for container orchestrator compatibility.
- **Authored Multi-Stage Containerfile:** Produced an unprivileged, multi-stage production `Dockerfile` (Node.js 20 Alpine) with automated healthcheck directives and `.dockerignore`.
- **Pruned Dependencies & Standardized Scripts:** Purged unused `cheerio` package and standardized `npm start` and `npm run dev` lifecycle commands.

## Getting Started

### Prerequisites

- **Node.js:** `v18.11.0+` (LTS recommended; tested on `v20+`)
- **npm:** `v9.0.0+`
- **API Credentials:**
  - OMDb API Key ([Register](https://www.omdbapi.com/apikey.aspx))
  - TMDB API Key ([Register](https://www.themoviedb.org/settings/api))

### Installation & Setup

1. **Clone repository and install dependencies:**
   ```bash
   git clone https://github.com/yourusername/cinescope.git
   cd cinescope
   npm ci
   ```

2. **Configure environment:**
   ```bash
   cp .env.example .env
   ```
   Populate `.env` with your active API keys:
   ```env
   OMDB_API_KEY=your_omdb_api_key_here
   TMDB_API_KEY=your_tmdb_api_key_here
   PORT=3000
   ```

3. **Launch service:**
   ```bash
   # Production mode
   npm start

   # Development mode (watch mode)
   npm run dev
   ```

### Containerized Execution (Docker)

```bash
# Build multi-stage image
docker build -t cinescope:latest .

# Run container with environment configuration
docker run -d \
  --name cinescope \
  -p 3000:3000 \
  -e OMDB_API_KEY=your_omdb_key \
  -e TMDB_API_KEY=your_tmdb_key \
  cinescope:latest
```

### Usage Examples

#### Web Interface
Navigate to `http://localhost:3000` and submit a title via the query input or trigger quick search directly via query parameters:
```text
http://localhost:3000/search?title=Oppenheimer
```

#### Health & Readiness Verification
```bash
# Liveness probe
curl -i http://localhost:3000/healthz

# Readiness probe (verifies database indexing and cache state)
curl -i http://localhost:3000/readyz

# Flush in-memory search cache (forces fresh upstream API fetches)
curl -X POST http://localhost:3000/cache/reset
```

Expected readiness response payload:
```json
{
  "status": "ready",
  "indexedMovies": 5115,
  "cacheEntries": 12
}
```

## Configuration

| Variable | Type | Default | Required | Description |
| :--- | :--- | :--- | :---: | :--- |
| `OMDB_API_KEY` | `string` | — | **Yes** | Authentication token for OMDb REST endpoints. |
| `TMDB_API_KEY` | `string` | — | No | API key for TMDB v3 entity resolution and cast credit aggregation. |
| `PORT` | `number` | `3000` | No | Network port binding for the HTTP server process. |
| `NODE_ENV` | `string` | `development` | No | Runtime environment (`development` or `production`). |

## Credits & External Services

- **[OMDb API](https://www.omdbapi.com/)**: RESTful web service for movie metadata, ratings, box office metrics, and IMDb entity identification.
- **[The Movie Database (TMDB)](https://www.themoviedb.org/)**: Community-built movie and TV database providing high-resolution cast headshots, role attributions, and audience voting scores. *(This product uses the TMDB API but is not endorsed or certified by TMDB).*
- **[Academy Awards Dataset](https://github.com/delventhalz/json-nominations)**: Curated historical Oscar nominations and winners dataset maintained by Zachary Delventhal.
- **[FontAwesome](https://fontawesome.com/)**: Icon library for user interface glyphs and status indicators.
- **[Google Fonts](https://fonts.google.com/)**: Typeface distribution for *Outfit* and *Plus Jakarta Sans*.

## Changelog

### [2.1.0] - Observability, Quality Gates, UI Architecture & Accessibility Hardening

#### Observability & Telemetry
- **Structured JSON Logging:** Integrated `pino` and `pino-http` for production-grade JSON log streaming with ISO timestamps, log levels, and automatic request correlation tracking (`x-request-id`).
- **Health Check Log Muting:** Configured `autoLogging` filters to suppress polling noise from high-frequency orchestrator probes (`/healthz`, `/readyz`).

#### Quality Assurance & CI/CD
- **Automated Testing Suite:** Implemented unit and integration test coverage across health endpoints, input validation, $O(1)$ Oscar index integrity, and LRU cache resolution using Jest and Supertest (`tests/app.test.js`).
- **GitHub Actions Quality Gate:** Configured `.github/workflows/ci.yml` pipeline testing across Node.js versions (18.x, 20.x, 22.x) and validating multi-stage Docker container builds on push and pull requests.
- **Supply Chain Validation:** Added content-length limits and JSON array payload assertions to remote database fallback ingestion in `loadOscarData()`.

#### Accessibility & UI Resilience (WCAG 2.1 AA)
- **Repositioned Ratings & Reviews Dropdown Accordion:** Converted the Academy Awards card in the primary dashboard column (`lg:col-span-8`) into a full-width, collapsible Ratings & Reviews dropdown menu, hidden by default on initial page load with inline `display: none` and `hidden` classes.
- **Embedded Academy Awards & Honors Section:** Integrated historic Academy Awards (Oscars) wins, nomination categories, and industry recognition directly beneath the Critic Ratings Breakdown inside the Ratings & Reviews dropdown block.
- **De-cluttered Left Sidebar Navigation:** Removed the *Show Ratings & Reviews* toggle button from the *Quick Specifications* card, keeping primary actions focused strictly on entity links.
- **Responsive Gauge & Metric Layout:** Expanded the Visual Ratings Engine dials across a 4-column responsive grid (`grid-cols-2 sm:grid-cols-4`) with side-by-side critic breakdown cards for optimal wide-viewport legibility.
- **Toggle Ratings & Reviews Accordion Controller:** Enhanced the dropdown header button (`#toggleRatingsBtn`) with bidirectional state toggle, dynamic label switching (*Show Ratings & Reviews* / *Hide Ratings & Reviews*), debounce timestamp protection, animated chevron indicator rotation (`#toggleRatingsIcon`), and accessible `aria-expanded` / `aria-controls` bindings.
- **Streamlined Tab Deck:** Maintained dashboard tabs focused cleanly on *Cast & Crew* and *Specifications*, eliminating viewport jump and tab panel interference.
- **Header & Specification Layout Reorganization:** Relocated formatted runtime and MPAA rating badges to the primary title header tag row alongside release year and genre, replacing their entries in the sidebar *Quick Specifications* card with releasing studio and production budget metrics.
- **Accessible History Drawer:** Added `role="dialog"`, `aria-modal="true"`, and `aria-labelledby` semantics to the search history drawer alongside descriptive button labels.
- **WAI-ARIA Tab Navigation & State Management:** Structured movie details tabs with `role="tablist"`, `role="tab"`, dynamic `aria-selected` toggling, and `role="tabpanel"` associations.
- **Programmatic Event Binding:** Added explicit `DOMContentLoaded` click event listeners with `preventDefault()` across tab controls, the ratings accordion trigger, the navbar expandable search button, the search history drawer trigger, drawer close/overlay elements, and history reset actions.
- **Fault-Tolerant History Storage:** Wrapped all client-side `localStorage` operations in robust parsing checks and try-catch error guards to prevent script failure in restricted browser storage contexts.
- **Global Keyboard Trapping & Click-Outside Handling:** Bound an `Escape` key event listener to dismiss open drawers, search containers, and full-screen poster modals cleanly, alongside click-outside auto-collapse for the search bar.

### [2.0.0] - Production Hardening & Optimization

#### Performance & Scalability
- **Constructed In-Memory Oscar Index:** Replaced runtime linear array scans ($O(N \times M)$) across 10,568 nominations with an in-memory `Map<string, Nomination[]>` keyed by IMDb ID, reducing nomination lookup latency from multiple milliseconds to $< 0.1$ ms.
- **Integrated LRU Caching Tier:** Deployed in-memory `lru-cache` with a 500-entry capacity and 1-hour TTL, resolving repeat queries in sub-millisecond time and mitigating upstream API quota depletion.
- **Converted File I/O to Asynchronous:** Migrated local dataset ingestion from synchronous blocking calls to `fs.promises` to maintain event-loop responsiveness during boot.

#### Security & Compliance
- **Enforced Encrypted Transport:** Switched OMDb endpoints from plaintext `http://` to TLS `https://`, preventing credential exposure and man-in-the-middle tampering.
- **Integrated Security Headers:** Configured `helmet` middleware with a granular Content Security Policy (CSP), enforcing frame restrictions, MIME-sniffing prevention, and origin isolation.
- **Established Multi-Tier Rate Limiting:** Integrated `express-rate-limit` across three boundaries:
  - Global middleware (300 requests / 15 minutes per IP).
  - Search endpoint (30 queries / minute per IP) with dedicated 429 status rendering.
  - Telemetry endpoint (20 payloads / 15 minutes per IP).
- **Hardened Client Telemetry:** Enforced payload size constraints (`10kb` body parser limit, 200-character string truncation) and sanitized incoming messages to strip ANSI escape sequences and ASCII control characters.

#### Reliability & Resiliency
- **Configured Request Timeouts:** Bound all outbound Axios network operations to an explicit 4,000 ms timeout to prevent socket descriptor exhaustion and connection starvation.
- **Enforced Input Boundary Validation:** Added strict type-checking, trimming, and character bounds (1–100 characters) on `req.query.title`, returning immediate HTTP 400 Bad Request responses on invalid input.
- **Orchestrated Graceful Shutdown:** Registered `SIGTERM` and `SIGINT` handlers to flush and terminate active HTTP connections before process exit.
- **Added Configuration Assertions:** Implemented bootstrap environment validation to output explicit warnings when required API keys are missing.

#### Infrastructure & DevOps
- **Integrated Cloud Health Probes:** Added `/healthz` (liveness probe) and `/readyz` (readiness probe asserting database indexing and cache health).
- **Parameterized Port Binding:** Bound HTTP listener to `process.env.PORT || 3000` for container orchestrator compatibility.
- **Authored Multi-Stage Containerfile:** Produced an unprivileged, multi-stage production `Dockerfile` (Node.js 20 Alpine) with automated healthcheck directives and `.dockerignore`.
- **Pruned Dependencies & Standardized Scripts:** Purged unused `cheerio` package and standardized `npm start` and `npm run dev` lifecycle commands.

## License

This project is distributed under the [ISC License](https://opensource.org/licenses/ISC).
