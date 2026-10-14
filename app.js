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
    logger.warn('TMDB_API_KEY is not defined in environment variables! TMDB cast details will be skipped.');
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
            imgSrc: ["'self'", "data:", "https://m.media-amazon.com", "https://image.tmdb.org", "https://upload.wikimedia.org", "https://images.unsplash.com"],
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

    const cacheKey = movieTitle.toLowerCase();
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
        
        let castData = [];
        const imdbId = response.data.imdbID;

        if (imdbId && imdbId !== "N/A" && TMDB_KEY) {
            try {
                const findRes = await httpClient.get(`https://api.themoviedb.org/3/find/${encodeURIComponent(imdbId)}`, {
                    params: {
                        external_source: 'imdb_id',
                        api_key: TMDB_KEY
                    }
                });
                
                let tmdbId = null;
                let isMovie = true;
                let tmdbMovie = null;

                if (findRes.data.movie_results && findRes.data.movie_results.length > 0) {
                    tmdbMovie = findRes.data.movie_results[0];
                    tmdbId = tmdbMovie.id;
                    isMovie = true;
                } else if (findRes.data.tv_results && findRes.data.tv_results.length > 0) {
                    tmdbMovie = findRes.data.tv_results[0];
                    tmdbId = tmdbMovie.id;
                    isMovie = false;
                }

                if (tmdbId) {
                    const mediaType = isMovie ? 'movie' : 'tv';
                    const detailRes = await httpClient.get(`https://api.themoviedb.org/3/${mediaType}/${tmdbId}`, {
                        params: { 
                            api_key: TMDB_KEY,
                            append_to_response: 'credits'
                        }
                    });
                    const tmdbData = detailRes.data;
                    castData = (tmdbData.credits && tmdbData.credits.cast ? tmdbData.credits.cast : []).slice(0, 8);
                    response.data.tmdbRating = tmdbData.vote_average || tmdbMovie.vote_average;
                    response.data.tmdbVoteCount = tmdbData.vote_count || tmdbMovie.vote_count;
                    
                    if (isMovie && tmdbData.budget && tmdbData.budget > 0) {
                        response.data.Budget = '$' + Number(tmdbData.budget).toLocaleString();
                    }
                    if (tmdbData.production_companies && tmdbData.production_companies.length > 0) {
                        response.data.Studio = tmdbData.production_companies[0].name;
                    } else if (tmdbData.networks && tmdbData.networks.length > 0) {
                        response.data.Studio = tmdbData.networks[0].name;
                    }
                }
            } catch (tmdbError) {
                req.log.warn({ err: tmdbError.message }, 'Non-fatal degradation during TMDB query');
            }
        }

        // O(1) Instant Oscar lookup via in-memory Map
        const oscars = (imdbId && imdbId !== "N/A") ? (oscarIndex.get(imdbId) || []) : [];
        response.data.Oscars = oscars;
        response.data.DetailedCast = castData;

        // Store populated movie in LRU Cache
        searchCache.set(cacheKey, response.data);

        res.render('index', { movie: response.data, error: null });
    } catch (error) {
        req.log.error({ err: error.message }, 'Fatal error during external movie search');
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
    logger
};
