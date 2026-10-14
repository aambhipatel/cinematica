const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { LRUCache } = require('lru-cache');
const pino = require('pino');
const pinoHttp = require('pino-http');
const { randomUUID } = require('crypto');
require('dotenv').config();
const { createAggregation, searchKey, validId, formatWatchTime } = require('./aggregation');

// --- Production Structured Logger ---
const logger = pino({
    level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
        level: (label) => ({ level: label })
    }
});

const app = express();

// --- Configuration Verification ---
const API_KEY = process.env.OMDB_API_KEY;
const TMDB_KEY = process.env.TMDB_API_KEY;
const PORT = process.env.PORT || 3000;

if (!API_KEY && process.env.NODE_ENV !== 'test') {
    logger.warn('OMDB_API_KEY is not defined in environment variables! External film lookups will fail.');
}
if (!TMDB_KEY && process.env.NODE_ENV !== 'test') {
    logger.warn('TMDB_API_KEY is not defined in environment variables! Optional TMDB enrichment will be skipped.');
}

// --- Outbound HTTP Client with Resilient Timeouts ---
const httpClient = axios.create({
    timeout: 4000,
    headers: {
        'Accept-Encoding': 'gzip,deflate',
        'User-Agent': 'CineScope/2.0.0 (Production-Ready)'
    }
});

// --- In-Memory Caching (LRU) ---
const searchCache = new LRUCache({
    max: 500, // Store up to 500 unique movie search results
    ttl: 1000 * 60 * 60 // 1 hour TTL
});
const aggregation = createAggregation({ httpClient, cache: searchCache, logger });

// --- In-Memory Fast Oscar Database Indexing (O(1) Map) ---
let oscarData = [];
let oscarIndex = new Map();

// --- In-Memory IMDb Top 100 Dataset for Spotlight Shuffle ---
let imdbTop100 = [];
try {
    const top100Path = path.join(__dirname, 'imdb-top-100.json');
    if (fs.existsSync(top100Path)) {
        imdbTop100 = JSON.parse(fs.readFileSync(top100Path, 'utf8'));
        logger.info({ count: imdbTop100.length }, 'IMDb Top 100 database loaded successfully');
    }
} catch (err) {
    logger.warn({ err: err.message }, 'Failed to load local imdb-top-100.json');
}

function getRandomSpotlight(count = 5) {
    if (!Array.isArray(imdbTop100) || imdbTop100.length === 0) {
        return [];
    }
    const arr = [...imdbTop100];
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr.slice(0, count);
}

async function loadOscarData() {
    const localPath = path.join(__dirname, 'oscar-nominations.json');
    try {
        if (fs.existsSync(localPath)) {
            logger.info('Loading local Oscar database from disk...');
            const rawData = await fs.promises.readFile(localPath, 'utf8');
            oscarData = JSON.parse(rawData);
        } else {
            logger.warn('Local Oscar database missing. Fetching verified dataset from remote fallback...');
            const response = await httpClient.get(
                'https://raw.githubusercontent.com/delventhalz/json-nominations/master/oscar-nominations.json',
                { timeout: 10000, maxContentLength: 10 * 1024 * 1024 }
            );
            if (!Array.isArray(response.data)) {
                throw new Error('Invalid database format received from remote source (expected array)');
            }
            oscarData = response.data;
            await fs.promises.writeFile(localPath, JSON.stringify(oscarData, null, 2), 'utf8');
        }

        // Build Map index for O(1) instant search lookups
        const newIndex = new Map();
        for (let i = 0; i < oscarData.length; i++) {
            const item = oscarData[i];
            if (item && item.movies && Array.isArray(item.movies)) {
                for (let j = 0; j < item.movies.length; j++) {
                    const m = item.movies[j];
                    if (m && m.imdb_id) {
                        let list = newIndex.get(m.imdb_id);
                        if (!list) {
                            list = [];
                            newIndex.set(m.imdb_id, list);
                        }
                        list.push(item);
                    }
                }
            }
        }
        oscarIndex = newIndex;
        logger.info({ indexedMovies: oscarIndex.size, totalNominations: oscarData.length }, 'Oscar database indexed successfully');
    } catch (error) {
        logger.error({ err: error.message }, 'Failed to initialize Oscar database');
    }
}

// --- Request Correlation & Structured HTTP Logging ---
app.use(pinoHttp({
    logger,
    genReqId: (req) => req.headers['x-request-id'] || randomUUID(),
    autoLogging: {
        ignore: (req) => req.url === '/healthz' || req.url === '/readyz'
    }
}));

// --- Security Middleware (Helmet & Rate Limiting) ---
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.tailwindcss.com"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
            imgSrc: ["'self'", "data:", "https://m.media-amazon.com", "https://image.tmdb.org", "https://www.themoviedb.org", "https://static.tvmaze.com", "https://upload.wikimedia.org", "https://images.unsplash.com"],
            connectSrc: ["'self'"]
        }
    },
    crossOriginEmbedderPolicy: false
}));

// Global Rate Limiting
const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: 'Too many requests from this IP address. Please try again later.'
});
app.use(globalLimiter);

// Specific Search Rate Limiter to prevent API exhaustion
const searchLimiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 30,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req, res) => {
        res.status(429).render('index', {
            movie: null,
            error: "Too many search requests. Please slow down and try again shortly."
        });
    }
});

// Telemetry Log Limiter
const logLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: 'draft-7',
    legacyHeaders: false
});

// Request body parser with strict size limit
app.use(express.json({ limit: '10kb' }));
app.use(express.static('public'));
app.set('view engine', 'ejs');
app.locals.formatWatchTime = formatWatchTime;

const episodeLimiter = rateLimit({
    windowMs: 60 * 1000, max: 30, standardHeaders: 'draft-7', legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many episode requests. Please try again shortly.' } })
});
const apiError = (res, status, code, message) => res.status(status).json({ error: { code, message } });
function validateEpisodeRoute(req, res, next) {
    if (!validId(req.params.imdbId)) return apiError(res, 400, 'INVALID_ID', 'Use an IMDb title ID, such as tt0944947.');
    if (req.params.n !== undefined && (!/^(0|[1-9]\d{0,2})$/.test(req.params.n) || Number(req.params.n) > 200)) {
        return apiError(res, 400, 'INVALID_SEASON', 'Season must be an integer from 0 to 200.');
    }
    next();
}
async function episodeRoute(req, res) {
    try {
        const context = await aggregation.resolveTitle(req.params.imdbId, req.log);
        if (!context.movie) return apiError(res, context.partial ? 502 : 404, context.partial ? 'SOURCE_UNAVAILABLE' : 'NOT_FOUND', 'Could not load this title. Please retry.');
        if (!context.isTV) return apiError(res, 404, 'NOT_A_SERIES', 'This title has no TV seasons.');
        req.log.info({ imdbId: req.params.imdbId, season: req.params.n, event: 'episode_guide_request' }, 'Episode guide requested');
        if (req.params.n === undefined) return res.json({ imdbId: req.params.imdbId, seasons: context.seasons, partial: context.partial });
        const result = await aggregation.getSeason(req.params.imdbId, Number(req.params.n), context, { enrich: true });
        if (result.notFound) return apiError(res, 404, 'SEASON_NOT_FOUND', 'This season is not listed for this title.');
        if (result.unavailable) return apiError(res, 502, 'SOURCE_UNAVAILABLE', "Couldn't load episodes for this season. Please retry.");
        res.json({ imdbId: req.params.imdbId, ...result });
    } catch {
        req.log.warn({ event: 'episode_guide_error' }, 'Episode guide failed');
        apiError(res, 502, 'SOURCE_UNAVAILABLE', "Couldn't load episodes. Please retry.");
    }
}
app.get('/api/title/:imdbId/seasons', episodeLimiter, validateEpisodeRoute, episodeRoute);
app.get('/api/title/:imdbId/seasons/:n', episodeLimiter, validateEpisodeRoute, episodeRoute);

// --- Health & Readiness Probes ---
app.get('/healthz', (req, res) => {
    res.status(200).json({ status: 'healthy', uptime: process.uptime() });
});

app.get('/readyz', (req, res) => {
    if (oscarIndex.size === 0) {
        return res.status(503).json({ status: 'unready', reason: 'Oscar database index not yet loaded' });
    }
    res.status(200).json({
        status: 'ready',
        indexedMovies: oscarIndex.size,
        cacheEntries: searchCache.size
    });
});

// Cache Reset Endpoint
app.post('/cache/reset', (req, res) => {
    const previousEntries = searchCache.size;
    searchCache.clear();
    req.log.info({ previousEntries }, 'In-memory search cache cleared');
    res.status(200).json({ status: 'cleared', previousEntries, currentEntries: searchCache.size });
});

// --- Telemetry Endpoint (Hardened against ANSI Injection & DoS) ---
app.post('/log', logLimiter, (req, res) => {
    const rawMessage = req.body && typeof req.body.message === 'string' ? req.body.message : '';
    // Strip ANSI escapes and non-printable control characters; truncate to 200 chars
    const sanitized = rawMessage.slice(0, 200).replace(/[\u001b\u0000-\u001f]/g, '').trim();
    if (sanitized) {
        req.log.warn({ telemetryEvent: sanitized }, 'Client reported telemetry event');
    }
    res.sendStatus(204);
});

// --- Main Routes ---
app.get('/', (req, res) => {
    res.render('index', {
        movie: null,
        error: null,
        spotlight: getRandomSpotlight(5),
        allTop100: imdbTop100
    });
});

app.get('/api/spotlight', (req, res) => {
    res.status(200).json(getRandomSpotlight(5));
});

app.get('/search', searchLimiter, async (req, res) => {
    const rawTitle = req.query.title;

    // Strict input validation
    if (!rawTitle || typeof rawTitle !== 'string' || rawTitle.trim().length === 0) {
        return res.status(400).render('index', { movie: null, error: "Please enter a valid movie title." });
    }

    const movieTitle = rawTitle.trim();
    if (movieTitle.length > 100) {
        return res.status(400).render('index', { movie: null, error: "Search query is too long (maximum 100 characters)." });
    }

    const cacheKey = searchKey(movieTitle);
    const cachedResult = searchCache.get(cacheKey);
    if (cachedResult) {
        req.log.info({ cacheHit: true, title: movieTitle }, 'Cache hit resolving movie search');
        return res.render('index', { movie: cachedResult, error: null });
    }

    req.log.info({ cacheHit: false, title: movieTitle }, 'Cache miss fetching from upstream providers');
    try {
        const response = await httpClient.get('https://www.omdbapi.com/', {
            params: {
                t: movieTitle,
                apikey: API_KEY
            }
        });

        if (response.data.Response === "False") {
            req.log.warn({ title: movieTitle }, 'Upstream OMDb reported movie not found');
            return res.render('index', { movie: null, error: "Movie not found!" });
        }

        const imdbId = response.data.imdbID;
        const populated = await aggregation.enrichMovie(response.data, req.log);

        // O(1) Instant Oscar lookup via in-memory Map
        const oscars = (imdbId && imdbId !== "N/A") ? (oscarIndex.get(imdbId) || []) : [];
        populated.Oscars = oscars;

        // Store populated movie in LRU Cache
        aggregation.remember(cacheKey, populated, populated.Partial);

        res.render('index', { movie: populated, error: null });
    } catch (error) {
        req.log.error({ status: error.response?.status || null }, 'Fatal error during external movie search');
        res.status(500).render('index', { movie: null, error: "Error fetching data. Please try again later." });
    }
});

// --- Server Bootstrap & Graceful Shutdown ---
let server;

async function bootstrap() {
    await loadOscarData();
    server = app.listen(PORT, () => {
        logger.info({ port: PORT, env: process.env.NODE_ENV || 'development' }, 'CineScope HTTP server operational');
    });
    return server;
}

function handleShutdown(signal) {
    logger.info({ signal }, 'Received termination signal. Starting graceful shutdown...');
    if (server) {
        server.close(() => {
            logger.info('All active HTTP connections closed. Process terminating cleanly.');
            process.exit(0);
        });
        setTimeout(() => {
            logger.error('Graceful shutdown timeout exceeded. Forcing exit.');
            process.exit(1);
        }, 5000).unref();
    } else {
        process.exit(0);
    }
}

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));

if (require.main === module) {
    bootstrap().catch(err => {
        logger.fatal({ err }, 'Fatal bootstrap initialization failure');
        process.exit(1);
    });
}

module.exports = {
    app,
    bootstrap,
    loadOscarData,
    searchCache,
    getOscarIndex: () => oscarIndex,
    getRandomSpotlight,
    getImdbTop100: () => imdbTop100,
    logger,
    aggregation,
    httpClient,
    searchKey,
    episodeLimiter
};
