const request = require('supertest');
const { LRUCache } = require('lru-cache');
const { app, searchCache, httpClient, resultsLimiter } = require('../app');
const { HOUR } = require('../aggregation');
const { createResultsSearch, validateSearch, resultsKey, detailKey, mapResults, rememberResults, exactId, safeResultsURL, RESULT_PREFIX } = require('../search-results');
const log = { info: jest.fn(), warn: jest.fn() };
const record = (id, title = 'Batman', extra = {}) => ({ imdbID: id, Title: title, Year: '1989', Type: 'movie', Poster: 'N/A', ...extra });
const response = (...records) => ({ data: { Response: 'True', totalResults: String(records.length), Search: records } });
const state = (extra = {}) => ({ query: 'Batman', page: 1, type: 'all', year: '', ...extra });
function service() {
    const cache = new LRUCache({ max: 500, ttl: HOUR });
    const client = { get: jest.fn() };
    return { client, cache, api: createResultsSearch({ httpClient: client, cache, logger: log, env: { OMDB_API_KEY: 'secret-test-key' } }) };
}
beforeEach(() => {
    jest.clearAllMocks(); searchCache.clear(); httpClient.get.mockReset();
    for (const key of ['127.0.0.1', '::ffff:127.0.0.1', '::1', '::/56']) resultsLimiter.resetKey(key);
});
describe('Search validation and exact IDs', () => {
    test.each([
        [{}, 'INVALID_QUERY'], [{ q: '' }, 'INVALID_QUERY'], [{ q: '   ' }, 'INVALID_QUERY'], [{ q: 'a'.repeat(101) }, 'INVALID_QUERY'], [{ q: ['a','b'] }, 'INVALID_QUERY'],
        [{ q: 'a', page: '0' }, 'INVALID_PAGE'], [{ q: 'a', page: '-1' }, 'INVALID_PAGE'], [{ q: 'a', page: '101' }, 'INVALID_PAGE'], [{ q: 'a', page: '1.5' }, 'INVALID_PAGE'], [{ q: 'a', page: '01' }, 'INVALID_PAGE'],
        [{ q: 'a', type: 'person' }, 'INVALID_TYPE'], [{ q: 'a', type: ['movie', 'series'] }, 'INVALID_TYPE'],
        [{ q: 'a', year: '1887' }, 'INVALID_YEAR'], [{ q: 'a', year: String(new Date().getFullYear() + 6) }, 'INVALID_YEAR'], [{ q: 'a', year: '99' }, 'INVALID_YEAR'], [{ q: 'a', year: '20xx' }, 'INVALID_YEAR'], [{ q: 'a', year: ['2000', '2001'] }, 'INVALID_YEAR']
    ])('rejects %j with %s', async (query, code) => {
        const res = await request(app).get('/api/search').query(query);
        expect(res.status).toBe(400); expect(res.body.error.code).toBe(code); expect(httpClient.get).not.toHaveBeenCalled();
    });
    test('normalizes whitespace, supplies defaults, accepts bounds and explicit episodes', () => {
        expect(validateSearch({ q: '  The   Office  ' })).toEqual(state({ query: 'The Office' }));
        expect(validateSearch({ q: 'a', page: '100', type: 'episode', year: '1888' })).toMatchObject({ page: 100, type: 'episode', year: '1888' });
        expect(validateSearch({ q: 'a', year: '2031' }, 2026).year).toBe('2031');
    });
    test('exact-ID shortcut skips all providers and redirects the results shell', async () => {
        expect(exactId('tt0096895')).toBe(true); expect(exactId('tt123456789')).toBe(true); expect(exactId('tt123')).toBe(false); expect(exactId('tt1234567890')).toBe(false);
        const res = await request(app).get('/api/search?q=tt0096895');
        expect(res.body.redirect).toBe('/search?title=tt0096895'); expect(httpClient.get).not.toHaveBeenCalled();
        const page = await request(app).get('/search?q=tt0096895'); expect(page.status).toBe(302); expect(page.headers.location).toBe('/search?title=tt0096895');
    });
    test('rejects external or malformed back links and preserves valid filters', () => {
        expect(safeResultsURL('https://attacker.test/search?q=batman')).toBeNull(); expect(safeResultsURL('//attacker.test/search?q=batman')).toBeNull(); expect(safeResultsURL('/search?title=tt0096895')).toBeNull();
        expect(safeResultsURL('/search?q=batman&page=2&type=movie&year=1989')).toBe('/search?q=batman&page=2&type=movie&year=1989');
    });
});
describe('Clean response mapping and provider failures', () => {
    test('maps only allowed fields, dedupes IDs, drops episodes and unsafe posters, pins an exact title on page one', () => {
        const data = { Response: 'True', totalResults: '23', Search: [
            record('tt0000001', 'Batman Begins', { Plot: 'must not leak', imdbRating: '9' }), record('tt0000002'), record('tt0000002', 'duplicate'), record('tt0000003', 'Episode', { Type: 'episode' }), record('bad', 'invalid'), record('tt0000004', 'TV', { Type: 'series', Poster: 'javascript:alert(1)' })
        ] };
        const clean = mapResults(data, state());
        expect(clean).toMatchObject({ query: 'Batman', page: 1, totalResults: 23, totalPages: 3 });
        expect(clean.results.map(r => r.imdbId)).toEqual(['tt0000002', 'tt0000001', 'tt0000004']);
        expect(clean.results[0]).toEqual({ imdbId: 'tt0000002', title: 'Batman', year: '1989', type: 'movie', poster: null });
        expect(JSON.stringify(clean)).not.toContain('must not leak'); expect(mapResults(data, state({ page: 2 })).results[0].imdbId).toBe('tt0000001');
        expect(mapResults(data, state({ type: 'episode' })).results.map(r => r.imdbId)).toEqual(['tt0000003']);
    });
    test('keeps API-supplied text as inert strings and normalizes missing years', () => {
        const clean = mapResults({ Search: [record('tt0000001', '<script>alert(1)</script>', { Year: 'N/A', Poster: 'https://m.media-amazon.com/test.jpg' })], totalResults: '1' }, state());
        expect(clean.results[0]).toMatchObject({ title: '<script>alert(1)</script>', year: '', poster: 'https://m.media-amazon.com/test.jpg' });
    });
    test('sends s/page/type/y, never per-result details, and logs metadata without secrets', async () => {
        const { api, client } = service(); client.get.mockResolvedValue(response(record('tt0000001')));
        await api.search(state({ page: 2, type: 'movie', year: '1989' }));
        expect(client.get).toHaveBeenCalledTimes(1);
        expect(client.get.mock.calls[0][1]).toMatchObject({ params: { s: 'Batman', page: 2, type: 'movie', y: '1989', apikey: 'secret-test-key' }, timeout: 4000 });
        expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ event: 'results_search_request', queryLength: 6 }), expect.any(String));
        expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ event: 'results_search_complete', resultCount: 1 }), expect.any(String));
        expect(JSON.stringify(log.info.mock.calls)).not.toContain('Batman'); expect(JSON.stringify(log.info.mock.calls)).not.toContain('secret-test-key');
    });
    test('not-found returns a cacheable empty success and does not require TMDB', async () => {
        httpClient.get.mockResolvedValue({ data: { Response: 'False', Error: 'Movie not found!' } });
        const res = await request(app).get('/api/search?q=missing');
        expect(res.status).toBe(200); expect(res.body).toEqual({ query: 'missing', page: 1, totalResults: 0, totalPages: 0, results: [] }); expect(httpClient.get).toHaveBeenCalledTimes(1);
    });
    test('too-many-results asks for refinement and is never cached', async () => {
        httpClient.get.mockResolvedValue({ data: { Response: 'False', Error: 'Too many results.' } });
        const res = await request(app).get('/api/search?q=a');
        expect(res.status).toBe(422); expect(res.body.error.code).toBe('REFINE_QUERY'); expect(searchCache.size).toBe(0);
    });
    test.each(['Invalid API key!', 'Request limit reached!', 'Incorrect IMDb ID.'])('OMDb failure %s is not empty success or cached', async Error => {
        httpClient.get.mockResolvedValue({ data: { Response: 'False', Error } });
        const res = await request(app).get('/api/search?q=batman');
        expect(res.status).toBe(502); expect(res.body.error.code).toBe('SOURCE_UNAVAILABLE'); expect(searchCache.size).toBe(0); expect(JSON.stringify(res.body)).not.toContain(Error);
    });
    test('network and malformed payload failures are isolated, logged, not cached', async () => {
        const { api, client, cache } = service();
        client.get.mockRejectedValueOnce(new Error('apikey=secret-test-key')).mockResolvedValueOnce({ data: { Response: 'True', totalResults: '10' } });
        await expect(api.search(state())).rejects.toMatchObject({ status: 502, code: 'SOURCE_UNAVAILABLE' });
        await expect(api.search(state())).rejects.toMatchObject({ status: 502 });
        expect(cache.size).toBe(0); expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'results_search_failure', source: 'OMDb' }), expect.any(String));
        expect(JSON.stringify(log.warn.mock.calls)).not.toContain('secret-test-key');
    });
});
describe('Cache partition, expiry, rate limiting, and exact details', () => {
    test('case/whitespace variants hit the same key and page/type/year stay distinct', async () => {
        const { api, client } = service(); client.get.mockResolvedValue(response(record('tt0000001', 'The Office')));
        await api.search(state({ query: 'The Office' })); await api.search(state({ query: 'the   office' }));
        expect(client.get).toHaveBeenCalledTimes(1); expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ event: 'results_search_cache', cacheHit: true }), expect.any(String));
        const keys = [state(), state({ page: 2 }), state({ type: 'movie' }), state({ year: '1989' })].map(resultsKey); expect(new Set(keys).size).toBe(4);
    });
    test('coalesces identical in-flight searches', async () => {
        const { api, client } = service(); client.get.mockResolvedValue(response(record('tt0000001')));
        await Promise.all([api.search(state()), api.search(state())]); expect(client.get).toHaveBeenCalledTimes(1);
    });
    test('one-hour expiry and at most 100 result pages inside the 500-entry cache', () => {
        let now = 100;
        const cache = new LRUCache({ max: 500, ttl: HOUR, ttlResolution: 0, perf: { now: () => now } });
        for (let i = 0; i < 400; i++) cache.set(detailKey('tt' + i), { title: 'preserved' });
        for (let i = 0; i < 550; i++) rememberResults(cache, resultsKey(state({ query: 'query' + i })), { results: [] });
        expect(cache.size).toBe(500); expect([...cache.keys()].filter(k => k.startsWith(RESULT_PREFIX))).toHaveLength(100);
        for (let i = 0; i < 400; i++) expect(cache.has(detailKey('tt' + i))).toBe(true);
        const key = resultsKey(state()); rememberResults(cache, key, { results: [] }); expect(cache.getRemainingTTL(key)).toBe(HOUR);
        now += HOUR + 1; expect(cache.get(key)).toBeUndefined();
    });
    test('new route has JSON rate limiting', async () => {
        httpClient.get.mockResolvedValue(response(record('tt0000001')));
        for (let i = 0; i < 30; i++) expect((await request(app).get('/api/search?q=batman')).status).toBe(200);
        const res = await request(app).get('/api/search?q=batman'); expect(res.status).toBe(429); expect(res.body.error.code).toBe('RATE_LIMITED');
    });
    test('ID details call i rather than t and use a separate cache key', async () => {
        const movie = { Title: 'Chosen Batman', imdbID: 'tt0096895', Type: 'movie', Runtime: '126 min', Ratings: [], Awards: 'N/A', Poster: 'N/A', Response: 'True' };
        httpClient.get.mockImplementation(async url => {
            if (url.includes('omdb')) return { data: movie };
            if (url.includes('/find/')) return { data: { movie_results: [] } };
            return { data: { results: { bindings: [] } } };
        });
        const res = await request(app).get('/search').query({ title: 'tt0096895', from: '/search?q=batman&page=2&type=movie' });
        expect(res.status).toBe(200); expect(res.text).toContain('Chosen Batman'); expect(res.text).toContain('id="backToResults"');
        const omdbCall = httpClient.get.mock.calls.find(([url]) => url.includes('omdb'));
        expect(omdbCall[1].params.i).toBe('tt0096895'); expect(omdbCall[1].params).not.toHaveProperty('t'); expect(searchCache.has(detailKey('tt0096895'))).toBe(true);
    });
    test('reload-safe results shell, query forms, and direct recommendation links', async () => {
        const res = await request(app).get('/search?q=batman&page=2&type=movie&year=1989');
        expect(res.status).toBe(200); expect(res.text).toContain('id="resultsView" class=" py-6'); expect(res.text).toContain('data-query-form'); expect(res.text).toContain('name="q"');
        const home = await request(app).get('/'); expect(home.text.includes('href="/search?title=tt')).toBe(true); expect(httpClient.get).not.toHaveBeenCalled();
    });
});
