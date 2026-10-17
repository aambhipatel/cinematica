# Cinematica

A lightweight, high-performance film metadata aggregator engineered to deliver objective film intelligence without biasing how you view the movie.

## Architecture

Cinematica acts as an aggregation and caching gateway between client browsers and external film metadata providers, backed by an in-memory historical database index.

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
1. **Submitted search:** The forms submit q to /search. The EJS results shell restores query, page, type, and year from the URL; its browser controller requests /api/search.
2. **Validation and cache:** The API validates query/filter bounds, applies IP rate limits, and checks a normalized results key in the shared 500-entry LRU. At most 100 entries can be result pages.
3. **OMDb search:** A miss makes one HTTPS OMDb s= request with page/type/y. Only title, year, IMDb ID, type, and a safe poster URL are returned. No per-result details are fetched.
4. **User selection:** A result opens /search?title=tt... and the details route uses OMDb i= for that exact record. Direct recommendations also use IDs. Legacy title-based direct links still use t= for compatibility.
5. **Details enrichment:** The existing TMDB/TVMaze/Wikidata aggregation and local Oscar index enrich only the selected record, using the existing detail/season caching and failure isolation.
6. **Delivery and navigation:** EJS renders details. The browser's History API, bounded memory/session cache, and saved scroll positions preserve results across paging, Back/Forward, and reloads.

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
   git clone https://github.com/yourusername/cinematica.git
   cd cinematica
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
docker build -t cinematica:latest .

# Run container with environment configuration
docker run -d \
  --name cinematica \
  -p 3000:3000 \
  -e OMDB_API_KEY=your_omdb_key \
  -e TMDB_API_KEY=your_tmdb_key \
  cinematica:latest
```

### Usage Examples

#### Web Interface
Navigate to `http://localhost:3000` and submit a title via the query input or trigger quick search directly via query parameters:
```text
http://localhost:3000/search?q=Oppenheimer
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
| `TVMAZE_ENABLED` | `string` | `true` | No | Set `false` to disable free TVMaze fallbacks; no API key required. |
| `WIKIDATA_ENABLED` | `string` | `true` | No | Set `false` to disable Wikidata fallbacks; no API key required. |
| `LOG_LEVEL` | `string` | `info` | No | Pino logging level. API credentials and upstream request configurations are never logged. |

## Search results and exact title selection

Submitted queries now show a results grid instead of silently choosing OMDb's first title match. The same single EJS view retains the current amber/charcoal design, movie/TV details, awards, episode guide, recommendations, and ten-item localStorage search history. There is no autocomplete or search-as-you-type.

### URLs and navigation

| View | URL example | Behavior |
| --- | --- | --- |
| Results | /search?q=batman&page=2&type=movie&year=1989 | Shareable state; filter changes reset page to 1. /?q=... is also restored by the browser controller. |
| Details | /search?title=tt0096895 | Exact OMDb i= lookup, separate versioned ID cache key. |
| Details from results | /search?title=tt0096895&from=%2Fsearch%3Fq%3Dbatman%26page%3D2%26type%3Dmovie | A validated same-origin return URL enables Back to results. External/malformed return links are discarded. |
| Legacy direct details | /search?title=Oppenheimer | Backward-compatible t= lookup for old bookmarks and title-only suggestion links. Search forms never use this path. |

Queries matching tt plus 7–9 digits go directly to exact-ID details. Results use pushState for submissions, filters, and pagination; selecting a title uses a normal link and separate document history entry. Browser Back/Forward restores the prior filters/page/scroll without an API request while a cached response is fresh. Back to results uses browser Back when a matching same-origin referrer is available, otherwise a reload-safe results URL. Up to 20 successful results responses are kept in memory and tab-scoped sessionStorage for one hour, including scroll positions. Storage failures degrade safely. Newly fetched responses renew their client expiry; cache hits do not.

Only submitted queries are stored in localStorage (case-insensitive dedupe, ten entries). History links open results. Result/recommendation clicks never store the title as a submitted search. Recommended Spotlight links use each local entry's IMDb ID and bypass results. Existing direct suggestion links and bookmarks remain supported. No existing route is unused or removed.

### Search API

GET /api/search?q=batman&page=1&type=all&year=1989

| Parameter | Validation |
| --- | --- |
| q | Required string; trim and require 1–100 characters; collapse internal whitespace for lookup/cache normalization. |
| page | Canonical integer 1–100, default 1. |
| type | all (default), movie, series; episode is accepted only when explicitly requested through the API. UI offers All / Movies / TV Series. |
| year | Optional four-digit year, 1888 through server current year + 5. Blank means no filter. |

Success returns { query, page, totalResults, totalPages, results: [{ imdbId, title, year, type, poster }] }. Poster N/A or an unapproved image URL becomes null; missing years become an empty string and are omitted in the UI. No raw upstream objects or invented ratings/runtime/plots are returned. Results are deduped by IMDb ID, episodes are dropped unless explicitly requested, and page 1 uses a stable partition to pin exact case-insensitive title matches. The remainder keeps OMDb's ordering. totalResults is the provider's count before per-page deduplication/episode filtering; totalPages is ceil(totalResults / 10), capped at the API's 100 accessible pages.

An exact-ID API query returns the same empty-results envelope plus redirect: /search?title=tt... without making an upstream call. OMDb Movie not found! is a normal 200 empty result and may be cached. Too many results. returns 422 REFINE_QUERY, inviting a more specific query/type/year. Quota, invalid-key, malformed-response, HTTP, and timeout failures return 502 SOURCE_UNAVAILABLE. Validation is 400; throttling is 429 RATE_LIMITED. Every error uses { error: { code, message } }, and no error response is cached.

The API has the existing 30 requests/minute/IP search convention and global 300 requests/15 minutes/IP limit. Each upstream search has a four-second timeout and 1 MiB response limit. Structured search events include query length, page/filter metadata, cache hit/miss, counts, and sanitized failure status; never API keys or provider error/configuration payloads. The existing HTTP access logger remains in place.

### Cache and source policy

Search pages use v1:results: plus JSON-encoded normalized lowercase query/page/type/year, avoiding key collisions. They share the existing one-hour, 500-entry LRU with details/title mappings/seasons, but are limited to 100 entries and evict the oldest results page when that quota is full. Up to the first 100 search insertions can displace older shared-cache entries; sustained search-only churn cannot replace the entire details/season cache. Cache reset clears every namespace. Simultaneous identical result requests are coalesced; failures leave no entry. Exact-ID details use v4:details: and legacy title details retain v3:search:.

OMDb is the sole results provider. Optional TMDB multi-search fallback and lazy result-card rating enrichment were deliberately left out: the chooser makes one provider call per page and works with only the OMDb key. Selecting a card triggers the existing enriched details route. Missing/broken posters have a consistent film placeholder. Changing search state aborts stale requests and generation guards prevent old responses from replacing newer results. Loading skeletons, empty/refinement/error/retry states, semantic lists, accessible link names, a live result count, visible focus, heading focus, and keyboard-operable filters/pagination are included.

OMDb's [current parameter documentation](https://www.omdbapi.com/) confirms s, page 1–100, type, y, i, and totalResults. Its official issue tracker documents [ten results per page](https://github.com/omdbapi/OMDb-API/issues/170), [Search result fields](https://github.com/omdbapi/OMDb-API/issues/139), and [overly broad query errors](https://github.com/omdbapi/OMDb-API/issues/164). Checked October 16, 2026. Search results lack detail ratings/plots/runtime, so those are neither fabricated nor eagerly fetched.

### Search verification

The existing Jest/Supertest suite is extended with offline tests for parameter boundaries, field mapping, exact IDs, stable ordering, dedupe/episode filtering, no-result/refinement/upstream errors, telemetry, rate limits, normalized cache keys, one-hour expiry, shared 500-entry/100-result quotas, coalescing, and exact-ID details. No frontend test framework, dependency, or build step was added. An isolated browser with mocked providers was used for search/filter/pagination, result selection, Back and scroll restoration, reload, history/recommendations, loading/empty/error/retry/refinement, stale response aborts, safe text, keyboard focus, broken posters, and desktop/mobile checks.

## TV series and aggregation

OMDb remains the primary title source. `Type: series` selects TV behavior and only TMDB `tv_results` are eligible in the IMDb `/find` lookup. This app has no TMDB-only title search path. `aggregation.js` assembles metrics as `{ value, source }`, and the EJS page uses tooltips or small source captions. Missing metrics and unavailable critic scores are omitted. Movie runtime formatting, Oscars, search history, recommendations, health probes, and shutdown behavior are retained.

| Metric | Source priority | Interpretation |
| --- | --- | --- |
| Avg. episode runtime | Real regular-season TMDB episode runtimes, filling gaps with TVMaze → TMDB `episode_run_time` → TMDB last aired episode runtime → TVMaze `averageRuntime` → OMDb single-minute series runtime | Equal weight per episode; specials and zero/missing runtimes excluded. Displays `~42 min / episode`. |
| Total watch time | Sum of known aired regular episode runtimes → fill missing runtimes using the above mean | Future and unknown-date episodes excluded. Missing data is marked `~`. An ended TMDB show's known episode count can estimate absent seasons; ongoing future-inclusive counts are never multiplied. Field disappears without a usable total. |
| Movie box office | OMDb `BoxOffice` → TMDB `revenue` → Wikidata P2142 | Tooltip distinguishes OMDb US box office from TMDB worldwide revenue. No currency conversion; zero is missing. |
| Movie budget | TMDB `budget` → Wikidata P2769 | USD for TMDB; Wikidata retains its declared currency (USD/EUR/GBP/JPY/INR/CAD/AUD). Unknown currencies are omitted. |
| IMDb / Rotten Tomatoes / Metacritic | OMDb only | IMDb can also use OMDb's Ratings array. No substitute is labeled Tomatometer or Metacritic. |
| Additional audience scores | TMDB; TVMaze for series | Displayed independently under their actual source names, never as critic-score substitutes. |
| Seasons / episode metadata | TMDB → TVMaze → OMDb season API | Merge by regular/special identity and season/episode number. OMDb supplies IMDb episode ratings on demand. |
| TV status / first and last air dates | TMDB → TVMaze; OMDb release date as first-air fallback | Show available fields only. |
| Studio / network | TMDB → TVMaze network/webChannel → Wikidata P272 → legacy OMDb Production | TV networks are preferred; first available TMDB company for films. |
| Cast | TMDB top eight → TVMaze cast for series → OMDb Actors | Directors/writers remain OMDb metadata. |
| Poster | OMDb → TMDB → TVMaze | Browser tries the next approved HTTPS image when a poster fails to load. |
| Primetime Emmy honors | Explicit OMDb `Awards` text → IMDb-linked Wikidata P166/P1411 statements | Other awards' totals are never counted as Emmys. Wikidata honors are labeled **recorded**, with incomplete coverage; unknown wins/nominations are omitted rather than displayed as zero. |
| Oscars | Local IMDb-indexed Oscar dataset | Movie behavior retained; series can display recorded Oscars after Emmys. Dataset ends in 2023. |

The **Episodes & Seasons** tab sits between Cast & Crew and Specifications. Season 1 is the consistent default (first listed regular season if Season 1 is absent). More than ten regular seasons use a native select. Specials are separate when the provider lists them or TVMaze episode records reveal them. Episode rows show available titles, dates, minutes, stills, summaries, and source-labeled ratings. Future air dates are marked Upcoming. Season ratings average only ratings from a single named source, with the rated-episode count, rather than mixing rating populations. Tabs support arrow keys, Home/End, and ARIA selection. Loading, empty, and retry states are included.

### Requests, cache, and failure behavior

- `GET /api/title/:imdbId/seasons` returns `{ imdbId, seasons, partial }`.
- `GET /api/title/:imdbId/seasons/:n` returns `{ imdbId, number, episodes, partial, unavailable, omdbChecked }`.
- IMDb IDs use `tt` plus digits (up to 12); season numbers are canonical integers 0–200. Errors use `{ error: { code, message } }`: 400 invalid parameters, 404 missing/non-series titles or absent seasons, 502 provider outage, and 429 throttling. A genuinely empty season returns 200 with `episodes: []`.
- Both routes share a 30-request/minute/IP limiter and the existing global limiter. Logs record IDs, season numbers, counts, source names, status codes, and fallback events; no secrets or full provider payloads.
- Search, title mapping, and seasons share **one** 500-entry LRU cache. Keys are versioned (`v3:search:…`, `v3:title:…`, `v3:season:…`) so new fields cannot collide with old search records. Complete results expire after one hour; failed/partial results after one minute. Cache reset clears every namespace. In-flight identical season/title calls are coalesced.
- Title rendering loads the season list and warms regular season data for aggregate statistics with four workers and a 12-second phase deadline. Every provider call has a timeout capped at four seconds. Unfinished data yields approximate statistics, and the guide lazily requests the selected season from that same cache. No episode-per-episode OMDb requests or speculative next-season prefetch are made. The guide adds one OMDb season call for IMDb episode ratings, keeping the cached runtimes and not extending the existing successful cache expiry.
- HTTP 429 responses establish a provider-host cooldown using Retry-After (60 seconds if absent). Other providers continue. A user retry reattempts failed season responses. Public APIs may still return missing records; those aren't invented or inferred from unrelated awards.
- Only `OMDB_API_KEY` is needed for basic operation. Without TMDB, TVMaze remains additive; both public sources can be disabled. With **only OMDb enabled**, `totalSeasons`, season episode dates/counts/ratings, explicit per-episode Runtime, Actors, and Emmy Awards text still work. No new credential is required; `.env` is not modified.

### Provider verification and licensing

Endpoint, authentication, quota, and licensing documentation was checked on October 13, 2026:

| Provider | Documented API / authentication | Limits and usage |
| --- | --- | --- |
| [OMDb](https://www.omdbapi.com/) | HTTPS title `t`/`i` and `i` + `Season`; `apikey` | [Free plan: 1,000/day](https://www.omdbapi.com/apikey.aspx); paid plan limits depend on subscription. Follow [OMDb terms](https://www.omdbapi.com/legal.htm). Dedicated poster API is patron-only and unused. |
| [TMDB](https://developer.themoviedb.org/reference/find-by-id) | `/find/{imdb_id}?external_source=imdb_id`, `/tv/{id}`, `/tv/{id}/season/{n}`, `/movie/{id}`; optional v3 `api_key` | [Rate limits](https://developer.themoviedb.org/docs/rate-limiting) are roughly 40/sec, subject to change; obey 429. [FAQ and attribution](https://developer.themoviedb.org/docs/faq): developer/noncommercial versus commercial licensing, approved branding, and non-endorsement notice. |
| [TVMaze](https://www.tvmaze.com/api) | `/lookup/shows?imdb=…`, `/shows/{id}/seasons`, `/seasons/{id}/episodes`, `/shows/{id}/episodes?specials=1`, `/shows/{id}/cast`; no key | At least 20 calls/10 seconds/IP; cooldown on 429. CC BY-SA data with attribution and ShareAlike. Footer links TVMaze and the data license. |
| [Wikidata](https://www.wikidata.org/wiki/Wikidata:Data_access) | `/sparql`, narrow P345 IMDb lookup, typed currency quantities and award statements; no key | CC0. [Usage constraints](https://www.mediawiki.org/wiki/Wikidata_Query_Service/Implementation#Usage_constraints) include query/time/concurrency limits and 429 backoff. One bounded query per title only when needed. |

Trakt is deliberately not integrated: its [current API Use Policy](https://developer.trakt.tv/docs/api-use-policy) prohibits collecting community ratings to supply another product and recommends contacting support for unlisted use cases. A standalone Cinematica rating aggregator is not clearly authorized; a future approved integration can be added. No IMDb, Rotten Tomatoes, Metacritic, Box Office Mojo, or Emmy-site scraping is performed. Missing RT/Metacritic scores stay absent while other legitimate scores remain visible.

Emmy dataset candidates were investigated, including [TidyTuesday's Emmy collection](https://github.com/rfordatascience/tidytuesday/blob/main/data/2021/2021-09-21/readme.md), which documents scraping the Emmy website. Upstream reuse rights were not established, so no local Emmy dataset is shipped. Wikidata statements also lack exhaustive show/person/category coverage; they are not presented as definitive career totals. OMDb explicit Emmy counts are preferred, and a show with no verified Emmy records has no Emmy card.

### Verification

`npm test` runs Jest/Supertest with a global Axios mock: external HTTP is never live in the suite. Coverage includes movie/TV rendering, unavailable-field removal, Emmy-specific parsing and recorded Wikidata honors, provider order/failure isolation, shared episode merging, specials/air-date/watch-time math, formatting, ID/season validation, empty/error responses, episode throttling, cache namespaces, one-hour/one-minute expiry, and the shared 500-entry cap. No frontend framework or build step was introduced.

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
