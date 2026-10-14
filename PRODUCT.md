# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Film enthusiasts, cinephiles, and researchers seeking a centralized, high-density movie intelligence dashboard. Users look up films to quickly analyze multi-source critical reception, historical Academy Awards achievements, deep technical specifications, and comprehensive cast/crew credits in one consolidated place without tab-hopping across multiple entertainment portals.

## Product Purpose

CineScope provides a unified cinematic dashboard aggregating critical consensus, historical awards records, and technical production data. Success means delivering instant, verified, and complete film intelligence through an intuitive, dense, and responsive search interface.

## Positioning

Unlike generic search engines or fragmented single-purpose film databases, CineScope aggregates cross-referenced data from OMDb, TMDB, and an in-memory historical Oscar index. It presents multi-source critic dials (IMDb, Rotten Tomatoes, Metacritic), Oscar nominations & wins, verified box office & technical specs (studio, budget, runtime, MPAA rating), and cast filmographies within a single unified view.

## Operating Context

- Web browser application used during movie night discovery, film analysis, or trivia/awards research.
- Operates on real-time external APIs (OMDb API, TMDB API) alongside an in-memory historical Oscar dataset.
- High-efficiency in-memory LRU caching layer minimizes redundant API calls and preserves rate limits.
- Client-side drawer keeps track of recent search history for quick re-queries.

## Capabilities and Constraints

- **Capabilities:**
  - Real-time movie title search with autocomplete/history tracking.
  - Multi-source critic score breakdown (Rotten Tomatoes, IMDb, Metascore) with visual gauge dials.
  - Historical Academy Awards breakdown (nominations and wins matched against an in-memory dataset).
  - Rich technical specifications (budget, studio/distributor, runtime, release year, MPAA rating).
  - Cast filmography cards with character credits and TMDB headshots.
  - Responsive poster view with fullscreen modal preview.
  - Local browser search history drawer.
- **Constraints:**
  - Dependent on OMDb API and TMDB API availability and rate limits.
  - Studio and budget data availability depends on TMDB movie details.
  - Fast, responsive dark-mode first interface.

## Brand Commitments

- **Name:** CineScope
- **Tone:** Premium cinematic command center: rich visual presentation, atmospheric dark theme, dense yet organized movie intelligence.

## Evidence on Hand

- Fully functional Express.js web server (`server.js`) with EJS views.
- Client-side interactive scripts (`public/app.js`) handling modal controls, search history drawer, and ratings toggle.
- Historical Academy Awards dataset indexed in memory (`data/oscars.json`).
- Tailwind CSS styling loaded via CDN.

## Product Principles

1. **Information Density with Hierarchy:** Present deep metadata (ratings, awards, specs, cast) without overwhelming the user, using clear modular grouping and visual hierarchy.
2. **Atmospheric Cinematic Focus:** Embrace a dark, immersive presentation that centers movie imagery and production prestige.
3. **Frictionless Discovery:** Keep search fast, recent queries instantly accessible, and related filmography easily navigable.
4. **Data Integrity & Attribution:** Consolidate disparate reputable film sources transparently and gracefully handle missing or partial metadata.
