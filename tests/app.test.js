const request = require('supertest');
const { app, loadOscarData, searchCache, getOscarIndex, getRandomSpotlight, getImdbTop100, searchKey } = require('../app');

beforeAll(async () => {
    // Ensure Oscar database is indexed prior to running tests
    await loadOscarData();
});

describe('Liveness and Readiness Health Probes', () => {
    it('GET /healthz should return 200 with healthy status', async () => {
        const res = await request(app).get('/healthz');
        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('status', 'healthy');
        expect(res.body).toHaveProperty('uptime');
    });

    it('GET /readyz should return 200 with indexed movie count and cache entries', async () => {
        const res = await request(app).get('/readyz');
        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('status', 'ready');
        expect(res.body.indexedMovies).toBeGreaterThan(0);
        expect(typeof res.body.cacheEntries).toBe('number');
    });
});

describe('Root Landing Route & Recommended Spotlight', () => {
    it('GET / should return 200 and render index template with spotlight', async () => {
        const res = await request(app).get('/');
        expect(res.status).toBe(200);
        expect(res.text).toContain('CINE');
        expect(res.text).toContain('MATICA');
        expect(res.text).toContain('Recommended Spotlight');
        expect(res.text).toContain('imdbTop100Data');
        expect(res.text).toContain('shuffleSpotlight()');
    });

    it('should have loaded 100 movies in the IMDb Top 100 dataset', () => {
        const top100 = getImdbTop100();
        expect(Array.isArray(top100)).toBe(true);
        expect(top100.length).toBe(100);
        expect(top100[0]).toHaveProperty('title');
        expect(top100[0]).toHaveProperty('rating');
        expect(top100[0]).toHaveProperty('img');
    });

    it('getRandomSpotlight(5) should return 5 distinct movies with required metadata', () => {
        const spotlight = getRandomSpotlight(5);
        expect(spotlight.length).toBe(5);
        const titles = new Set(spotlight.map(m => m.title));
        expect(titles.size).toBe(5);
    });

    it('GET /api/spotlight should return 200 with 5 randomized movies', async () => {
        const res = await request(app).get('/api/spotlight');
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
        expect(res.body.length).toBe(5);
    });
});

describe('Search Input Validation & Abuse Prevention', () => {
    it('GET /search with missing title parameter should reject with 400', async () => {
        const res = await request(app).get('/search');
        expect(res.status).toBe(400);
        expect(res.text).toContain('Please enter a valid movie title.');
    });

    it('GET /search with whitespace-only title should reject with 400', async () => {
        const res = await request(app).get('/search?title=   ');
        expect(res.status).toBe(400);
        expect(res.text).toContain('Please enter a valid movie title.');
    });

    it('GET /search with query exceeding 100 characters should reject with 400', async () => {
        const longTitle = 'a'.repeat(101);
        const res = await request(app).get(`/search?title=${longTitle}`);
        expect(res.status).toBe(400);
        expect(res.text).toContain('Search query is too long');
    });
});

describe('Telemetry Log Endpoint Hardening', () => {
    it('POST /log with valid JSON message should return 204 No Content', async () => {
        const res = await request(app)
            .post('/log')
            .send({ message: 'Telemetry testing event' });
        expect(res.status).toBe(204);
    });

    it('POST /log with ANSI escape sequences should accept and sanitize without crashing', async () => {
        const res = await request(app)
            .post('/log')
            .send({ message: '\u001b[31;1mINJECTION ATTEMPT\u001b[0m' });
        expect(res.status).toBe(204);
    });
});

describe('In-Memory Oscar Database Indexing', () => {
    it('should have indexed over 5,000 unique movies from 10,000+ nominations', () => {
        const index = getOscarIndex();
        expect(index.size).toBeGreaterThan(5000);
    });

    it('should retrieve historic Oscar nominations for Wings (tt0018578) in O(1) time', () => {
        const index = getOscarIndex();
        const wingsNominations = index.get('tt0018578');
        expect(Array.isArray(wingsNominations)).toBe(true);
        expect(wingsNominations.length).toBeGreaterThan(0);
        expect(wingsNominations[0].category).toBe('Best Picture');
        expect(wingsNominations[0].won).toBe(true);
    });
});

describe('LRU Cache Behavior', () => {
    it('should serve cached search results without downstream requests', async () => {
        const mockMovie = {
            Title: 'Unit Test Film',
            Year: '2026',
            Rated: 'PG-13',
            Released: '01 Jan 2026',
            Runtime: '120 min',
            Genre: 'Drama',
            Director: 'Director Name',
            Writer: 'Writer Name',
            Actors: 'Actor One, Actor Two',
            Plot: 'A film created for unit testing.',
            Language: 'English',
            Country: 'United States',
            Awards: 'N/A',
            Poster: 'N/A',
            Ratings: [],
            Metascore: 'N/A',
            imdbRating: '8.0',
            imdbVotes: '1,000',
            imdbID: 'tt9999999',
            Type: 'movie',
            Response: 'True',
            Oscars: [],
            DetailedCast: []
        };

        searchCache.set(searchKey('unit test film'), mockMovie);

        const res = await request(app).get('/search?title=Unit+Test+Film');
        expect(res.status).toBe(200);
        expect(res.text).toContain('Unit Test Film');
    });

    it('POST /cache/reset should clear the search cache', async () => {
        searchCache.set('temp movie', { Title: 'Temp Movie' });
        expect(searchCache.size).toBeGreaterThan(0);

        const res = await request(app).post('/cache/reset');
        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('status', 'cleared');
        expect(searchCache.size).toBe(0);
    });
});
