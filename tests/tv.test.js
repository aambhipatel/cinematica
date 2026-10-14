const request = require('supertest');
const { LRUCache } = require('lru-cache');
const { app, searchCache, searchKey, httpClient, aggregation, episodeLimiter } = require('../app');
const { createAggregation, aggregateMetric, parseEmmys, computeTVStats, formatWatchTime, money, contextKey, seasonKey, HOUR, PARTIAL_TTL, mapLimit } = require('../aggregation');
const log = { warn: jest.fn(), info: jest.fn() };
const baseMovie = { Title: 'Test Show', Type: 'series', imdbID: 'tt1234567', Runtime: 'N/A', Poster: 'N/A', Awards: 'N/A', Ratings: [], Year: '2026', Genre: 'Drama', Oscars: [], DetailedCast: [] };
function service(env = {}, perf) {
    const cache = new LRUCache({ max: 500, ttl: HOUR, perf, ttlResolution: 0 });
    const client = { get: jest.fn() };
    const api = createAggregation({ httpClient: client, cache, logger: log, env: { OMDB_API_KEY: 'test-omdb', TMDB_API_KEY: 'test-tmdb', TVMAZE_ENABLED: 'true', WIKIDATA_ENABLED: 'false', ...env } });
    return { api, cache, client };
}
function context(overrides = {}) {
    return { movie: { ...baseMovie }, isTV: true, seasons: [{ number: 1, episodeCount: 2 }], tmdb: null, maze: null, partial: false, ...overrides };
}
function episode(number, runtime, extra = {}) {
    return { number, season: 1, runtime, airDate: '2020-01-01', special: false, sources: { runtime: 'TMDB', metadata: 'TMDB' }, ...extra };
}
beforeEach(() => { searchCache.clear(); aggregation.cooldowns.clear(); httpClient.get.mockReset(); jest.clearAllMocks(); });

describe('Emmy counts and currency normalization', () => {
    test('parses Emmy-specific wins without borrowing other awards', () => {
        expect(parseEmmys('Won 12 Primetime Emmys. Another 40 wins & 100 nominations.')).toMatchObject({ wins: 12, nominations: null, source: 'OMDb' });
        expect(parseEmmys('Nominated for 3 Primetime Emmys. 6 wins & 25 nominations total.')).toMatchObject({ wins: null, nominations: 3 });
        expect(parseEmmys('Won 1 Primetime Emmy. Nominated for 2 Primetime Emmys.')).toMatchObject({ wins: 1, nominations: 2 });
        expect(parseEmmys('Won 4 Oscars. Another 100 nominations.')).toBeNull();
        expect(parseEmmys('Won 4 Daytime Emmys.')).toBeNull();
    });
    test('does not convert currencies or display zero as money', () => {
        expect(money('$1,200,000')).toBe('$1,200,000');
        expect(money(100, 'EUR')).toBe('€100');
        expect(money(0)).toBeNull(); expect(money('N/A')).toBeNull(); expect(money('£100')).toBeNull();
    });
});

describe('Average runtime and aired watch-time math', () => {
    test('weights real episodes equally and excludes specials and future episodes from watch time', () => {
        const stats = computeTVStats(context({ seasons: [{ number: 1 }, { number: 2 }, { number: 0 }] }), [
            { number: 1, episodes: [episode(1, 40), episode(2, 50), episode(3, 100, { special: true })] },
            { number: 2, episodes: [episode(1, 60), episode(2, 30, { airDate: '2099-01-01' })] },
            { number: 0, episodes: [episode(1, 1000)] }
        ]);
        expect(stats.averageRuntime.value).toBe(45); expect(stats.watchTime.value).toBe(150); expect(stats.watchTime.episodes).toBe(3); expect(stats.watchTime.approximate).toBe(false);
    });
    test('uses available mean to estimate missing/zero runtimes', () => {
        const stats = computeTVStats(context(), [{ number: 1, episodes: [episode(1, 40), episode(2, 0)] }]);
        expect(stats.averageRuntime.value).toBe(40); expect(stats.watchTime.value).toBe(80); expect(stats.watchTime.approximate).toBe(true);
    });
    test('ordered runtime fallbacks and no fabricated count', () => {
        const c = context({ tmdb: { episode_run_time: [0, 45], last_episode_to_air: { runtime: 30 } }, maze: { averageRuntime: 20 }, movie: { ...baseMovie, Runtime: '15 min' } });
        expect(computeTVStats(c, []).averageRuntime).toEqual({ value: 45, source: 'TMDB' });
        c.tmdb.episode_run_time = []; expect(computeTVStats(c, []).averageRuntime.value).toBe(30);
        c.tmdb = null; expect(computeTVStats(c, []).averageRuntime).toEqual({ value: 20, source: 'TVMaze' });
        c.maze = null; expect(computeTVStats(c, []).averageRuntime.value).toBe(15);
        c.movie.Runtime = '15–30 min'; expect(computeTVStats(c, []).averageRuntime.value).toBeNull();
        expect(computeTVStats(c, []).watchTime.value).toBeNull();
    });
    test('uses ended TMDB count only for absent seasons, never counts unknown/future air dates', () => {
        const c = context({ tmdb: { status: 'Ended', last_air_date: '2020-01-01', number_of_episodes: 4, episode_run_time: [30] } });
        expect(computeTVStats(c, []).watchTime).toMatchObject({ value: 120, approximate: true, episodes: 4 });
        c.tmdb.status = 'Returning Series'; expect(computeTVStats(c, []).watchTime.value).toBeNull();
        const stats = computeTVStats(c, [{ number: 1, episodes: [episode(1, 30, { airDate: null }), episode(2, 30, { airDate: '2099-01-01' })] }]);
        expect(stats.watchTime.value).toBeNull();
    });
    test('formats short and multi-day watch time with explicit approximation', () => {
        expect(formatWatchTime(3260, true)).toBe('~2 days 6 hrs 20 min');
        expect(formatWatchTime(140, true)).toBe('~2 hrs 20 min');
        expect(formatWatchTime(60)).toBe('1 hr'); expect(formatWatchTime(42)).toBe('42 min'); expect(formatWatchTime(null)).toBeNull();
    });
});

describe('Provider selection, failure isolation and shared season data', () => {
    test('lazy metric chain stops at first valid source and isolates a rejection', async () => {
        const later = jest.fn(() => 99);
        const result = await aggregateMetric([{ source: 'A', get: async () => { throw new Error('offline'); } }, { source: 'B', get: () => null }, { source: 'C', get: () => 42 }, { source: 'D', get: later }], log);
        expect(result).toEqual({ value: 42, source: 'C' }); expect(later).not.toHaveBeenCalled(); expect(log.warn).toHaveBeenCalled();
    });
    test('maps a series to tv_results even when movie_results also exists', async () => {
        const { api, client } = service();
        client.get.mockImplementation(async url => {
            if (url.includes('/find/')) return { data: { movie_results: [{ id: 9 }], tv_results: [{ id: 7 }] } };
            if (url.endsWith('/tv/7')) return { data: { seasons: [{ season_number: 1, episode_count: 2 }] } };
            return { data: null };
        });
        const c = await api.resolveTitle(baseMovie.imdbID, log, { ...baseMovie });
        expect(c.tmdbId).toBe(7); expect(client.get.mock.calls.some(([url]) => url.endsWith('/movie/9'))).toBe(false);
    });
    test('merges TMDB stills and overviews, TVMaze runtimes and OMDb IMDb scores without duplicate core calls', async () => {
        const { api, client, cache } = service();
        const c = context({ tmdbId: 7, seasons: [{ number: 1, mazeId: 10, episodeCount: 1 }] });
        client.get.mockImplementation(async (url) => {
            if (url.includes('/tv/7/season/1')) return { data: { episodes: [{ episode_number: 1, name: 'Pilot', air_date: '2020-01-01', overview: 'A pilot', still_path: '/still.jpg', runtime: null, vote_count: 10, vote_average: 8 }] } };
            if (url.includes('/seasons/10/episodes')) return { data: [{ number: 1, name: 'Pilot', runtime: 43, airdate: '2020-01-01', summary: '<p>Hello <script>bad()</script></p>' }] };
            if (url.includes('omdb')) return { data: { Episodes: [{ Episode: '1', Title: 'Pilot', Released: '2020-01-01', imdbRating: '9.2' }] } };
            throw new Error('Unexpected route');
        });
        const warmed = await api.getSeason(baseMovie.imdbID, 1, c);
        expect(warmed.episodes[0]).toMatchObject({ runtime: 43, plot: 'A pilot', rating: 8, ratingSource: 'TMDB', image: 'https://image.tmdb.org/t/p/w300/still.jpg' });
        const upgraded = await api.getSeason(baseMovie.imdbID, 1, c, { enrich: true });
        expect(upgraded.episodes[0].ratingSource).toBe('IMDb via OMDb'); expect(upgraded.episodes[0].rating).toBe(9.2);
        expect(client.get).toHaveBeenCalledTimes(3);
        await api.getSeason(baseMovie.imdbID, 1, c, { enrich: true }); expect(client.get).toHaveBeenCalledTimes(3);
        expect(cache.get(seasonKey(baseMovie.imdbID, 1)).episodes[0].runtime).toBe(43);
    });
    test('TMDB outage degrades to TVMaze metadata, cast, posters and episode runtimes', async () => {
        const { api, client, cache } = service();
        client.get.mockImplementation(async url => {
            if (url.includes('themoviedb')) throw { response: { status: 503 } };
            if (url.includes('/lookup/')) return { data: { id: 8, averageRuntime: 42, network: { name: 'Network' }, rating: { average: 8.2 }, image: { original: 'https://static.tvmaze.com/poster.jpg' } } };
            if (url.endsWith('/shows/8/seasons')) return { data: [{ id: 10, number: 1, episodeOrder: 2 }] };
            if (url.endsWith('/shows/8/cast')) return { data: [{ person: { name: 'Actor', image: { medium: 'https://static.tvmaze.com/actor.jpg' } }, character: { name: 'Role' } }] };
            if (url.includes('/seasons/10/episodes')) return { data: [{ number: 1, runtime: 40, airdate: '2020-01-01' }, { number: 2, runtime: 44, airdate: '2020-01-02' }] };
            throw new Error('Unexpected request');
        });
        const populated = await api.enrichMovie({ ...baseMovie });
        expect(populated.TV.averageRuntime).toEqual({ value: 42, source: 'TVMaze' });
        expect(populated.TV.watchTime.value).toBe(84); expect(populated.Partial).toBe(true);
        expect(populated.DetailedCast[0].name).toBe('Actor'); expect(populated.Poster).toBe('https://static.tvmaze.com/poster.jpg');
        expect(populated.Metrics.studio).toEqual({ value: 'Network', source: 'TVMaze' });
        expect(populated.Scores).toContainEqual(expect.objectContaining({ label: 'TVMaze', source: 'TVMaze' }));
        expect(cache.getRemainingTTL(contextKey(baseMovie.imdbID))).toBeLessThanOrEqual(PARTIAL_TTL);
    });
    test('OMDb-only configuration supplies seasons, runtime and episode IMDb ratings', async () => {
        const { api, client } = service({ TMDB_API_KEY: '', TVMAZE_ENABLED: 'false' });
        client.get.mockResolvedValue({ data: { Episodes: [{ Episode: '1', Title: 'Pilot', Released: '2020-01-01', imdbRating: '9.1' }] } });
        const result = await api.enrichMovie({ ...baseMovie, totalSeasons: '1', Runtime: '42 min', Awards: 'Won 1 Primetime Emmy.' });
        expect(result.TV.averageRuntime).toEqual({ value: 42, source: 'OMDb' });
        expect(result.TV.watchTime).toMatchObject({ value: 42, approximate: true });
        expect(result.Emmys.wins).toBe(1); expect(client.get).toHaveBeenCalledTimes(1);
    });
    test('Wikidata fallback retains currency and marks statements as recorded honors', async () => {
        const { api, client } = service({ TMDB_API_KEY: '', TVMAZE_ENABLED: 'false', WIKIDATA_ENABLED: 'true' });
        client.get.mockResolvedValue({ data: { results: { bindings: [
            { kind: { value: 'studio' }, label: { value: 'Production house' } },
            { kind: { value: 'win' }, label: { value: 'Primetime Emmy Award for Drama' }, statement: { value: 'statement1' }, date: { value: '2020-01-01' } }
        ] } } });
        const result = await api.enrichMovie({ ...baseMovie });
        expect(result.Emmys).toMatchObject({ wins: 1, nominations: null, recorded: true, source: 'Wikidata' });
        expect(result.Metrics.studio.source).toBe('Wikidata');
    });
    test('movie financial fallbacks prefer OMDb box office and TMDB budget before Wikidata', async () => {
        const { api, client } = service({ WIKIDATA_ENABLED: 'true' });
        client.get.mockImplementation(async url => {
            if (url.includes('/find/')) return { data: { movie_results: [{ id: 7 }] } };
            if (url.endsWith('/movie/7')) return { data: { budget: 10000, revenue: 50000, production_companies: [{ name: 'Studio' }], vote_average: 8, vote_count: 50 } };
            throw new Error('Lower priority source should not be called');
        });
        const result = await api.enrichMovie({ ...baseMovie, Type: 'movie', BoxOffice: '$20,000' });
        expect(result.Metrics.boxOffice).toEqual({ value: '$20,000', source: 'OMDb' });
        expect(result.Metrics.budget).toEqual({ value: '$10,000', source: 'TMDB' });
        expect(client.get).toHaveBeenCalledTimes(2);
        const fallback = service({ TMDB_API_KEY: '', WIKIDATA_ENABLED: 'true' });
        fallback.client.get.mockResolvedValue({ data: { results: { bindings: [
            { kind: { value: 'budget' }, amount: { value: '1000000' }, unitLabel: { value: 'euro' } },
            { kind: { value: 'boxOffice' }, amount: { value: '3000000' }, unitLabel: { value: 'United States dollar' } }
        ] } } });
        const wikiResult = await fallback.api.enrichMovie({ ...baseMovie, Type: 'movie', BoxOffice: 'N/A' });
        expect(wikiResult.Metrics.boxOffice).toEqual({ value: '$3,000,000', source: 'Wikidata' });
        expect(wikiResult.Metrics.budget).toEqual({ value: '€1,000,000', source: 'Wikidata' });
    });
    test('TVMaze specials are separated from regular episodes and excluded from statistics', async () => {
        const { api, client } = service({ TMDB_API_KEY: '', OMDB_API_KEY: '' });
        const c = context({ maze: { id: 8 }, seasons: [{ number: 1, mazeId: 10, episodeCount: 1 }] });
        client.get.mockResolvedValue({ data: [{ number: 1, runtime: 40, airdate: '2020-01-01', type: 'regular' }, { number: null, runtime: 100, airdate: '2020-01-01', type: 'significant_special' }] });
        const regular = await api.getSeason(baseMovie.imdbID, 1, c);
        expect(regular.episodes).toHaveLength(1); expect(c.seasons).toContainEqual(expect.objectContaining({ number: 0 }));
        const specials = await api.getSeason(baseMovie.imdbID, 0, c);
        expect(specials.episodes).toHaveLength(1); expect(specials.episodes[0].special).toBe(true);
        expect(computeTVStats(c, [regular, specials]).watchTime.value).toBe(40);
    });
    test('malformed cast and season lists cannot fail the whole title', async () => {
        const { api, client } = service();
        client.get.mockImplementation(async url => {
            if (url.includes('/find/')) return { data: { tv_results: [{ id: 7 }] } };
            if (url.endsWith('/tv/7')) return { data: { seasons: {}, credits: { cast: {} } } };
            if (url.includes('/lookup/')) return { data: { id: 8 } };
            return { data: {} };
        });
        const result = await api.enrichMovie({ ...baseMovie });
        expect(result.DetailedCast).toEqual([]); expect(result.TV.averageRuntime.value).toBeNull();
    });
    test('429 honors Retry-After without logging secrets or retrying the host', async () => {
        const { api, client } = service();
        client.get.mockRejectedValue({ response: { status: 429, headers: { 'retry-after': '60' } }, message: 'test-tmdb leaked' });
        await api.resolveTitle('tt1', log, { ...baseMovie, imdbID: 'tt1' });
        const calls = client.get.mock.calls.length;
        await api.resolveTitle('tt2', log, { ...baseMovie, imdbID: 'tt2' });
        expect(client.get).toHaveBeenCalledTimes(calls);
        expect(JSON.stringify(log.warn.mock.calls)).not.toContain('test-tmdb');
    });
    test('bounds concurrency and deadline-skips remote calls', async () => {
        let active = 0, maximum = 0;
        await mapLimit([1, 2, 3, 4, 5, 6], 3, async () => { active++; maximum = Math.max(active, maximum); await new Promise(resolve => setTimeout(resolve, 1)); active--; });
        expect(maximum).toBe(3);
        const { api, client } = service();
        const result = await api.getSeason(baseMovie.imdbID, 1, context({ tmdbId: 7 }), { deadline: Date.now() - 1 });
        expect(result.partial).toBe(true); expect(client.get).not.toHaveBeenCalled();
    });
});

describe('TV/movie rendering and field removal', () => {
    async function render(movie) {
        searchCache.set(searchKey(movie.Title), movie);
        return (await request(app).get('/search').query({ title: movie.Title })).text;
    }
    test('series replaces box office and movie runtime, shows Emmys and the middle guide tab', async () => {
        const html = await render({ ...baseMovie, Runtime: '120 min', BoxOffice: '$1,000', TV: { seasons: [], averageRuntime: { value: 42, source: 'TMDB' }, watchTime: { value: 3260, approximate: true, source: 'TMDB', episodes: 80, seasons: 3 } }, Emmys: parseEmmys('Won 12 Primetime Emmys.') });
        expect(html).toContain('Avg. episode runtime: ~42 min / episode'); expect(html).toContain('Total watch time'); expect(html).toContain('~2 days 6 hrs 20 min');
        expect(html).not.toContain('>Box Office<'); expect(html).not.toContain('2 hrs'); expect(html).toContain('Won 12 Primetime Emmys');
        expect(html.indexOf('id="btn-castTab"')).toBeLessThan(html.indexOf('id="btn-episodesTab"')); expect(html.indexOf('id="btn-episodesTab"')).toBeLessThan(html.indexOf('id="btn-metaTab"'));
    });
    test('series with unavailable metrics omits fields and gray award placeholders', async () => {
        const html = await render({ ...baseMovie, TV: { seasons: [], averageRuntime: { value: null }, watchTime: { value: null } } });
        expect(html).not.toContain('data-metric="episode-runtime"'); expect(html).not.toContain('data-metric="watch-time"'); expect(html).not.toContain('data-metric="box-office"');
        expect(html).not.toContain('aria-label="Primetime Emmys"'); expect(html).not.toContain('No Academy Awards'); expect(html).not.toContain('>N/A<');
    });
    test('movie retains formatted runtime, financial fields, Oscars and no episode tab', async () => {
        const html = await render({ ...baseMovie, Type: 'movie', Runtime: '120 min', BoxOffice: '$100,000', Budget: '$50,000', Oscars: [{ won: true, category: 'Best Picture' }] });
        expect(html).toContain('2 hrs'); expect(html).toContain('>Box Office<'); expect(html).toContain('$100,000'); expect(html).toContain('Won 1 Oscar');
        expect(html).not.toContain('id="btn-episodesTab"'); expect(html).not.toContain('data-metric="episode-runtime"');
    });
    test('missing critic scores disappear and true audience sources remain labeled', async () => {
        const html = await render({ ...baseMovie, Scores: [{ label: 'TMDB', value: 8, max: 10, source: 'TMDB' }] });
        expect(html).toContain('via TMDB'); expect(html).not.toContain('>Tomatometer<'); expect(html).not.toContain('>Metacritic<');
    });
    test('third-party text is escaped in initial HTML', async () => {
        const html = await render({ ...baseMovie, Title: '<script>alert(1)</script>', Plot: '<img src=x onerror=alert(1)>' });
        expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<script>alert(1)</script>'); expect(html).toContain('&lt;img');
    });
    test('search renders a series through mocked upstream calls and stores new fields in the shared cache', async () => {
        httpClient.get.mockImplementation(async url => {
            if (url.includes('omdb')) return { data: { ...baseMovie, Title: 'Upstream test show', Runtime: '42 min', Awards: 'Won 3 Primetime Emmys.', Response: 'True' } };
            if (url.includes('/find/')) return { data: { tv_results: [] } };
            if (url.includes('/lookup/')) throw { response: { status: 503 } };
            if (url.includes('wikidata')) return { data: { results: { bindings: [] } } };
            throw new Error('Unexpected external provider');
        });
        const res = await request(app).get('/search').query({ title: 'Upstream test show' });
        expect(res.status).toBe(200); expect(res.text).toContain('Won 3 Primetime Emmys');
        const cached = searchCache.get(searchKey('Upstream test show'));
        expect(cached.TV.averageRuntime.value).toBe(42); expect(cached.Partial).toBe(true);
        expect(searchCache.getRemainingTTL(searchKey('Upstream test show'))).toBeLessThanOrEqual(PARTIAL_TTL);
    });
});

describe('Season routes and cache limits', () => {
    beforeEach(() => episodeLimiter.resetKey('::ffff:127.0.0.1'));
    test.each(['/api/title/bad/seasons', '/api/title/tt123/seasons/-1', '/api/title/tt123/seasons/1.5', '/api/title/tt123/seasons/201', '/api/title/tt123/seasons/01'])('rejects invalid route %s before HTTP', async route => {
        const res = await request(app).get(route);
        expect(res.status).toBe(400); expect(res.body.error.code).toMatch(/INVALID/); expect(httpClient.get).not.toHaveBeenCalled();
    });
    test('lists series seasons and serves a cached episode response', async () => {
        searchCache.set(contextKey(baseMovie.imdbID), context());
        searchCache.set(seasonKey(baseMovie.imdbID, 1), { number: 1, episodes: [episode(1, 42)], partial: false, omdbChecked: true });
        const list = await request(app).get(`/api/title/${baseMovie.imdbID}/seasons`); expect(list.status).toBe(200); expect(list.body.seasons).toHaveLength(1);
        const season = await request(app).get(`/api/title/${baseMovie.imdbID}/seasons/1`); expect(season.status).toBe(200); expect(season.body.episodes[0].runtime).toBe(42); expect(httpClient.get).not.toHaveBeenCalled();
    });
    test('a missing title returns 404 without leaking the OMDb error', async () => {
        httpClient.get.mockResolvedValue({ data: { Response: 'False', Error: 'Movie not found!' } });
        const res = await request(app).get('/api/title/tt7777777/seasons');
        expect(res.status).toBe(404); expect(res.body.error.code).toBe('NOT_FOUND');
    });
    test('returns 404 for movie/nonexistent season and 200 for a genuinely empty season', async () => {
        searchCache.set(contextKey(baseMovie.imdbID), context({ isTV: false, movie: { ...baseMovie, Type: 'movie' } }));
        expect((await request(app).get(`/api/title/${baseMovie.imdbID}/seasons`)).status).toBe(404);
        searchCache.set(contextKey(baseMovie.imdbID), context());
        expect((await request(app).get(`/api/title/${baseMovie.imdbID}/seasons/2`)).status).toBe(404);
        searchCache.set(seasonKey(baseMovie.imdbID, 1), { number: 1, episodes: [], omdbChecked: true, partial: false });
        const empty = await request(app).get(`/api/title/${baseMovie.imdbID}/seasons/1`); expect(empty.status).toBe(200); expect(empty.body.episodes).toEqual([]);
    });
    test('unavailable season returns recoverable 502 and rate limiting is JSON', async () => {
        searchCache.set(contextKey(baseMovie.imdbID), context());
        searchCache.set(seasonKey(baseMovie.imdbID, 1), { number: 1, episodes: [], omdbChecked: true, unavailable: true, partial: true });
        expect((await request(app).get(`/api/title/${baseMovie.imdbID}/seasons/1`)).status).toBe(502);
        for (let i = 0; i < 29; i++) await request(app).get(`/api/title/${baseMovie.imdbID}/seasons`);
        const blocked = await request(app).get(`/api/title/${baseMovie.imdbID}/seasons`); expect(blocked.status).toBe(429); expect(blocked.body.error.code).toBe('RATE_LIMITED');
    });
    test('versioned keys share a 500-entry cap, hour expiry, and short degraded TTL', () => {
        let time = 100;
        const { api, cache } = service({}, { now: () => time });
        for (let i = 0; i < 501; i++) api.remember(seasonKey('tt' + i, 1), { episodes: [] });
        expect(cache.size).toBe(500); expect(cache.has(seasonKey('tt0', 1))).toBe(false);
        api.remember(searchKey('show'), { Title: 'show' }, false);
        api.remember(contextKey('tt1000'), { seasons: [] }, true);
        expect(cache.getRemainingTTL(searchKey('show'))).toBeGreaterThan(HOUR - 1000);
        expect(cache.getRemainingTTL(contextKey('tt1000'))).toBeLessThanOrEqual(PARTIAL_TTL);
        expect(searchKey('SHOW')).toBe(searchKey(' show ')); expect(seasonKey('tt1', 1)).not.toBe(seasonKey('tt1', 2));
        time += PARTIAL_TTL + 1;
        expect(cache.get(contextKey('tt1000'))).toBeUndefined(); expect(cache.get(searchKey('show'))).toBeDefined();
        time += HOUR;
        expect(cache.get(searchKey('show'))).toBeUndefined();
    });
});
