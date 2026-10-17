const { HOUR, image } = require('./aggregation');
const RESULT_PREFIX = 'v1:results:';
const RESULT_CACHE_LIMIT = 100;
const normalizeQuery = q => q.trim().replace(/\s+/g, ' ');
const exactId = q => /^tt\d{7,9}$/.test(q);
const detailKey = id => 'v4:details:' + id;
const resultsKey = state => RESULT_PREFIX + JSON.stringify([normalizeQuery(state.query).toLowerCase(), state.page, state.type, state.year]);
function searchError(status, code, message) { return Object.assign(new Error(message), { status, code }); }
function validateSearch(params, currentYear = new Date().getFullYear()) {
    if (typeof params.q !== 'string' || !params.q.trim() || params.q.trim().length > 100) throw searchError(400, 'INVALID_QUERY', 'Enter a search query between 1 and 100 characters.');
    const page = params.page === undefined ? '1' : params.page;
    if (typeof page !== 'string' || !/^[1-9]\d{0,2}$/.test(page) || Number(page) > 100) throw searchError(400, 'INVALID_PAGE', 'Page must be an integer from 1 to 100.');
    const type = params.type === undefined ? 'all' : params.type;
    // Episode search is available explicitly via the API; the compact UI offers movie/TV filters.
    if (typeof type !== 'string' || !['all', 'movie', 'series', 'episode'].includes(type)) throw searchError(400, 'INVALID_TYPE', 'Type must be all, movie, series, or episode.');
    const year = params.year === undefined || params.year === '' ? '' : params.year;
    if (typeof year !== 'string' || year && (!/^\d{4}$/.test(year) || Number(year) < 1888 || Number(year) > currentYear + 5)) throw searchError(400, 'INVALID_YEAR', 'Year must be between 1888 and ' + (currentYear + 5) + '.');
    return { query: normalizeQuery(params.q), page: Number(page), type, year };
}
function safeResultsURL(value) {
    if (typeof value !== 'string' || value.length > 1000) return null;
    try {
        const url = new URL(value, 'http://local');
        if (url.origin !== 'http://local' || !['/search', '/'].includes(url.pathname)) return null;
        const state = validateSearch(Object.fromEntries(url.searchParams));
        return '/search?' + new URLSearchParams({ q: state.query, page: state.page, type: state.type, ...(state.year ? { year: state.year } : {}) });
    } catch { return null; }
}
function rememberResults(cache, key, value) {
    // One shared 500-entry LRU, with at most 100 result pages. Browse churn can
    // consume at most 100 slots; a prefix alone would not protect title/season data.
    if (!cache.has(key)) {
        const keys = [...cache.keys()].filter(k => typeof k === 'string' && k.startsWith(RESULT_PREFIX));
        if (keys.length >= RESULT_CACHE_LIMIT) cache.delete(keys[keys.length - 1]);
    }
    cache.set(key, value, { ttl: HOUR });
}
function mapResults(data, state) {
    const total = Number(data.totalResults);
    if (!Array.isArray(data.Search) || !Number.isSafeInteger(total) || total < 0) throw searchError(502, 'SOURCE_UNAVAILABLE', 'Search is temporarily unavailable. Please retry.');
    const seen = new Set();
    const results = data.Search.slice(0, 10).flatMap(item => {
        if (!item || typeof item.imdbID !== 'string' || !exactId(item.imdbID) || typeof item.Title !== 'string' || !['movie', 'series', 'episode'].includes(item.Type) || state.type !== 'all' && item.Type !== state.type || item.Type === 'episode' && state.type !== 'episode' || seen.has(item.imdbID)) return [];
        seen.add(item.imdbID);
        return [{ imdbId: item.imdbID, title: item.Title, year: typeof item.Year === 'string' && item.Year !== 'N/A' ? item.Year : '', type: item.Type, poster: image(item.Poster) }];
    });
    // Stable partition on page 1 only: exact title matches first, all other OMDb order preserved.
    if (state.page === 1) results.sort((a, b) => Number(normalizeQuery(b.title).toLowerCase() === state.query.toLowerCase()) - Number(normalizeQuery(a.title).toLowerCase() === state.query.toLowerCase()));
    return { query: state.query, page: state.page, totalResults: total, totalPages: Math.min(100, Math.ceil(total / 10)), results };
}
function createResultsSearch({ httpClient, cache, logger, env = process.env }) {
    const pending = new Map();
    async function search(state, log = logger) {
        log.info({ event: 'results_search_request', queryLength: state.query.length, page: state.page, type: state.type, year: state.year || null }, 'Search results requested');
        if (exactId(state.query)) return { query: state.query, page: state.page, totalResults: 0, totalPages: 0, results: [], redirect: '/search?title=' + state.query };
        const key = resultsKey(state), cached = cache.get(key);
        log.info({ event: 'results_search_cache', cacheHit: Boolean(cached), queryLength: state.query.length, page: state.page }, 'Search results cache lookup');
        if (cached) {
            log.info({ event: 'results_search_complete', resultCount: cached.results.length, totalResults: cached.totalResults }, 'Search results served');
            return { ...cached, query: state.query };
        }
        if (pending.has(key)) return { ...await pending.get(key), query: state.query };
        const work = (async () => {
            try {
                if (!env.OMDB_API_KEY) throw new Error('OMDb is not configured');
                const response = await httpClient.get('https://www.omdbapi.com/', { params: { s: state.query, page: state.page, ...(state.type !== 'all' ? { type: state.type } : {}), ...(state.year ? { y: state.year } : {}), apikey: env.OMDB_API_KEY }, timeout: 4000, maxContentLength: 1024 * 1024 });
                const data = response.data;
                let result;
                if (data?.Response === 'False') {
                    if (data.Error === 'Movie not found!') result = { query: state.query, page: state.page, totalResults: 0, totalPages: 0, results: [] };
                    else if (data.Error === 'Too many results.') throw searchError(422, 'REFINE_QUERY', 'Too many results. Add a more specific title, type, or year.');
                    else throw new Error('OMDb rejected the request');
                } else if (data?.Response === 'True') result = mapResults(data, state);
                else throw new Error('Invalid search response');
                rememberResults(cache, key, result);
                log.info({ event: 'results_search_complete', resultCount: result.results.length, totalResults: result.totalResults }, 'Search results assembled');
                return result;
            } catch (error) {
                log.warn({ event: 'results_search_failure', source: 'OMDb', status: error.response?.status || error.status || null, code: error.code === 'REFINE_QUERY' ? error.code : 'SOURCE_UNAVAILABLE' }, 'Search provider could not complete the request');
                // Never log Axios errors/configuration or raw upstream text: they can contain keys.
                if (error.code === 'REFINE_QUERY') throw error;
                throw searchError(502, 'SOURCE_UNAVAILABLE', 'Search is temporarily unavailable. Please retry.');
            }
        })();
        pending.set(key, work);
        try { return await work; } finally { pending.delete(key); }
    }
    return { search };
}
module.exports = { createResultsSearch, validateSearch, normalizeQuery, exactId, detailKey, resultsKey, rememberResults, mapResults, safeResultsURL, RESULT_PREFIX, RESULT_CACHE_LIMIT };
