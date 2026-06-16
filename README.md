# FilmFinder

FilmFinder is a modern, responsive movie discovery and lookup web application. It integrates multiple media metadata APIs (OMDb and TMDB) with a local Academy Awards database to deliver rich film analytics, critic reviews, audience ratings, cast bios, and Oscar nomination records in a beautiful glassmorphic visual interface.

---

## Features

- **Unified Cinematic Search**: Query metadata for millions of movies, TV shows, and anime series in real-time.
- **Academy Awards Cross-Reference**: Automatically matches search queries with a comprehensive local Oscar nominations database, highlighting historic wins and nominations by IMDb ID.
- **Visual Ratings Engine**: Compares scores dynamically across IMDb, Rotten Tomatoes (Tomatometer), TMDB (Audience Score), and Metacritic using custom SVG radial progress indicators.
- **Detailed Cast & Specifications**: Fetches TMDB profile photos and role attributions for the top cast, alongside box office metrics, release details, runtimes, and ratings.
- **Persistent Search History Drawer**: Locally stores and retrieves query history via `localStorage` for rapid navigation, featuring complete HTML sanitization to prevent injection risks.
- **Developer Telemetry Pipeline**: Built-in backend endpoint (`/log`) to stream client-side layout or asset errors (like missing poster links) straight to the server console.

---

## Technical Stack & Architecture

- **Backend**: Node.js, Express.js
- **Frontend / Templating**: EJS (Embedded JavaScript), Tailwind CSS, FontAwesome
- **HTTP Client**: Axios (configured with safe query parameters object serialization)
- **Environment Management**: Dotenv
- **Data Stores**: Local JSON database (`oscar-nominations.json`) with an automated raw GitHub CDN fallback on initialization.

---

## Security Best Practices

To make this project safe for public open-source distribution on GitHub, several key security measures have been built in:
1. **API Token Isolation**: Private keys (OMDb & TMDB API keys) are managed purely through environment variables inside an ignored `.env` file. A `.env.example` file is provided to guide setup.
2. **SSRF & Parameter Injection Prevention**: Request parameters sent to the external OMDb and TMDB REST endpoints are systematically serialized using Axios's native configuration parameters object rather than raw string concatenation.
3. **DOM-based XSS Mitigation**: Search logs retrieved from the browser's local storage are sanitized through a client-side HTML escaping engine before being dynamically injected into the UI history panel.

---

## Getting Started

Follow these steps to get a local development instance of FilmFinder running on your machine.

### Prerequisites

Make sure you have [Node.js](https://nodejs.org/) installed (v16+ recommended). You will also need:
- An OMDb API key (Get one at the OMDb API website)
- A TMDB API key (Get one in your TMDB account settings)

### Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/yourusername/filmfinder.git
   cd filmfinder
   ```

2. **Install the dependencies:**
   ```bash
   npm install
   ```

3. **Set up the environment variables:**
   Copy the example environment file and fill in your API tokens:
   ```bash
   cp .env.example .env
   ```
   Open the newly created `.env` file and replace the placeholder text with your actual credentials:
   ```env
   OMDB_API_KEY=your_omdb_api_key_here
   TMDB_API_KEY=your_tmdb_api_key_here
   ```

4. **Start the development server:**
   ```bash
   node app.js
   ```

5. **Open the application:**
   Navigate to `http://localhost:3000` in your web browser.

---

## License

This project is open-source and available under the [ISC License](LICENSE).
