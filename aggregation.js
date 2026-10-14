const HOUR = 60 * 60 * 1000;
const PARTIAL_TTL = 60 * 1000;
const SCHEMA = 'v3';
const validId = id => typeof id === 'string' && /^tt\d{1,12}$/.test(id);
const present = value => value !== undefined && value !== null && value !== '' && value !== 'N/A';
const positive = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null;
const text = value => typeof value === 'string' ? value.replace(/<[^>]*>/g, '').trim() : '';
const list = value => Array.isArray(value) ? value : [];
const image = value => {
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && ['m.media-amazon.com', 'image.tmdb.org', 'static.tvmaze.com'].includes(url.hostname) ? url.href : null;
    } catch { return null; }
};
const metric = (value, source) => ({ value: present(value) ? value : null, source: present(value) ? source : null });
const searchKey = title => `${SCHEMA}:search:${title.trim().toLowerCase()}`;
const contextKey = id => `${SCHEMA}:title:${id}`;
const seasonKey = (id, n) => `${SCHEMA}:season:${id}:${n}`;

// First valid value wins. Providers are lazy; exceptions cannot stop later sources.
async function aggregateMetric(sources, log) {
    for (const { source, get } of sources) {
        try {
            const value = await get();
            if (present(value)) return metric(value, source);
        } catch {
            log?.warn({ source, event: 'metric_fallback' }, 'Metric source unavailable');
        }
    }
    return metric(null, null);
}

function money(value, currency = 'USD') {
    if (!present(value)) return null;
    const amount = typeof value === 'number' ? positive(value) : positive(String(value).replace(/^(?:USD\s*|\$)/i, '').replace(/,/g, ''));
    if (!amount || !/^[A-Z]{3}$/.test(currency)) return null;
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount);
}

function parseEmmys(awards) {
    // OMDb explicitly names Primetime Emmys. "Another N wins & M nominations"
    // covers ALL awards, so it must never be treated as Emmy data. Wikidata's
    // P166/P1411 statements are the secondary source, labeled recorded (not totals).
    // Scraped Emmy datasets without verified upstream rights are deliberately unused.
    const value = text(awards);
    const wins = value.match(/\bWon\s+(\d+)\s+Primetime\s+Emmys?\b/i);
    const nominations = value.match(/\bNominated\s+for\s+(\d+)\s+Primetime\s+Emmys?\b/i);
    if (!wins && !nominations) return null;
    return { wins: wins ? Number(wins[1]) : null, nominations: nominations ? Number(nominations[1]) : null, source: 'OMDb', recorded: false, categories: [] };
}

function formatWatchTime(minutes, approximate = false) {
    if (!positive(minutes)) return null;
    const total = Math.round(minutes);
    const hours = Math.floor(total / 60), mins = total % 60;
    const parts = hours >= 48
        ? [Math.floor(hours / 24) + ' days', hours % 24 ? hours % 24 + ' hrs' : '', mins ? mins + ' min' : '']
        : [hours ? hours + (hours === 1 ? ' hr' : ' hrs') : '', mins ? mins + ' min' : ''];
    return (approximate ? '~' : '') + parts.filter(Boolean).join(' ');
}

function aired(episode, now = Date.now()) {
    // Unknown dates cannot prove an episode has aired. Prefer TVMaze's timestamp.
    const timestamp = Date.parse(episode.airTimestamp || episode.airDate);
    return Number.isFinite(timestamp) && timestamp <= now;
}

function computeTVStats(context, seasonResults, now = Date.now()) {
    const regular = seasonResults.filter(s => s && s.number > 0);
    const episodes = regular.flatMap(s => s.episodes).filter(e => !e.special);
    const runtimes = episodes.map(e => positive(e.runtime)).filter(Boolean);
    const tmdbRuns = list(context.tmdb?.episode_run_time).map(positive).filter(Boolean);
    // OMDb Runtime is accepted only for an explicit series and a single minute figure.
    const omdbRun = context.movie.Type === 'series' && /^\d+\s+min$/i.test(context.movie.Runtime || '')
        ? positive(parseInt(context.movie.Runtime, 10)) : null;
    const candidates = [
        [runtimes.length ? runtimes.reduce((a, b) => a + b, 0) / runtimes.length : null, [...new Set(episodes.filter(e => positive(e.runtime)).map(e => e.sources.runtime))].join(' + ')],
        [tmdbRuns.length ? tmdbRuns.reduce((a, b) => a + b, 0) / tmdbRuns.length : null, 'TMDB'],
        [positive(context.tmdb?.last_episode_to_air?.runtime), 'TMDB'],
        [positive(context.maze?.averageRuntime), 'TVMaze'], [omdbRun, 'OMDb']
    ];
    const [average, source] = candidates.find(([v]) => positive(v)) || [null, null];
    const airedEpisodes = episodes.filter(e => aired(e, now));
    let total = 0, estimated = false;
    for (const episode of airedEpisodes) {
        if (positive(episode.runtime)) total += Number(episode.runtime);
        else if (average) { total += average; estimated = true; }
    }
    const failedSeasons = context.seasons.filter(s => s.number > 0 && !regular.some(r => r.number === s.number && !r.unavailable));
    const incomplete = context.partial || failedSeasons.length > 0 || regular.some(s => s.partial);
    // A trusted all-aired episode count can fill absent season lists. TMDB's total
    // includes upcoming episodes, so only use it when last_air_date is in the past
    // and the show is ended. Never multiply a future-inclusive count blindly.
    let count = airedEpisodes.length;
    if (average && context.tmdb?.status === 'Ended' && context.tmdb?.last_air_date && Date.parse(context.tmdb.last_air_date) <= now) {
        const knownCount = positive(context.tmdb.number_of_episodes);
        if (knownCount > count && failedSeasons.length) { total += (knownCount - count) * average; count = knownCount; estimated = true; }
    }
    const unknownDates = episodes.some(e => !e.airDate && !e.airTimestamp);
    return {
        averageRuntime: metric(average ? Math.round(average) : null, source),
        watchTime: { ...metric(total ? Math.round(total) : null, source || 'Episode data'), approximate: estimated || incomplete || unknownDates || airedEpisodes.some(e => !positive(e.runtime)), episodes: count, seasons: context.seasons.filter(s => s.number > 0).length },
        partial: Boolean(incomplete)
    };
}

async function mapLimit(items, limit, work) {
    const output = new Array(items.length);
    let index = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (index < items.length) { const current = index++; output[current] = await work(items[current]); }
    }));
    return output;
}

function createAggregation({ httpClient, cache, logger, env = process.env }) {
    const pending = new Map();
    const cooldowns = new Map();
    const settings = () => ({ omdb: env.OMDB_API_KEY, tmdb: env.TMDB_API_KEY, maze: env.TVMAZE_ENABLED !== 'false', wiki: env.WIKIDATA_ENABLED !== 'false' });
    const remember = (key, value, partial = value.partial) => { cache.set(key, value, { ttl: partial ? PARTIAL_TTL : HOUR }); return value; };
    async function once(key, work) {
        if (pending.has(key)) return pending.get(key);
        const promise = work(); pending.set(key, promise);
        try { return await promise; } finally { pending.delete(key); }
    }
    async function get(source, url, params, state, { missingOK = true } = {}) {
        const host = new URL(url).host;
        if (state.deadline && Date.now() >= state.deadline || (cooldowns.get(host) || 0) > Date.now()) { state.partial = true; return null; }
        try {
            const response = await httpClient.get(url, {
                params, timeout: Math.max(1, Math.min(4000, state.deadline ? state.deadline - Date.now() : 4000)),
                maxContentLength: 5 * 1024 * 1024,
                headers: source === 'Wikidata' ? { Accept: 'application/sparql-results+json', 'User-Agent': 'CineScope/2.2 (https://github.com/aambhipatel/filmfinder; title metadata aggregation)' } : undefined
            });
            if (source === 'OMDb' && response.data?.Response === 'False') {
                if (/limit|key|invalid|too many/i.test(response.data.Error || '')) state.partial = true;
                return null;
            }
            return response.data;
        } catch (error) {
            const status = error.response?.status;
            if (status !== 404 || !missingOK) state.partial = true;
            if (status === 429) {
                const retry = error.response?.headers?.['retry-after'];
                const seconds = Number(retry);
                const until = Number.isFinite(seconds) ? Date.now() + Math.max(1, seconds) * 1000 : Date.parse(retry);
                cooldowns.set(host, Number.isFinite(until) ? until : Date.now() + 60000);
            }
            // Never log Axios errors/configs: they can contain query-string keys.
            logger.warn({ source, status: status || null, event: 'source_fallback' }, 'Metadata source unavailable; continuing');
            return null;
        }
    }
    const tmdbGet = (path, state, extra = {}) => settings().tmdb ? get('TMDB', `https://api.themoviedb.org/3/${path}`, { api_key: settings().tmdb, ...extra }, state) : null;
    const omdbGet = (params, state) => settings().omdb ? get('OMDb', 'https://www.omdbapi.com/', { apikey: settings().omdb, ...params }, state) : null;

    async function wikidata(id, state, awards = false) {
        if (!settings().wiki || !validId(id)) return {};
        // One narrowly scoped IMDb lookup; retain currency units, never invent FX.
        const query = `PREFIX wdt: <http://www.wikidata.org/prop/direct/>
        PREFIX p: <http://www.wikidata.org/prop/> PREFIX ps: <http://www.wikidata.org/prop/statement/>
        PREFIX psv: <http://www.wikidata.org/prop/statement/value/> PREFIX pq: <http://www.wikidata.org/prop/qualifier/>
        PREFIX wikibase: <http://wikiba.se/ontology#> PREFIX bd: <http://www.bigdata.com/rdf#>
        PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
        SELECT ?kind ?amount ?unitLabel ?label ?statement ?date WHERE {
          ?title wdt:P345 "${id}".
          { ?title p:P2769/psv:P2769 ?q. ?q wikibase:quantityAmount ?amount; wikibase:quantityUnit ?unit. BIND("budget" AS ?kind) }
          UNION { ?title p:P2142/psv:P2142 ?q. ?q wikibase:quantityAmount ?amount; wikibase:quantityUnit ?unit. BIND("boxOffice" AS ?kind) }
          UNION { ?title wdt:P272 ?company. BIND("studio" AS ?kind) ?company rdfs:label ?label. FILTER(LANG(?label)="en") }
          ${awards ? `UNION { VALUES (?p ?ps ?kind) { (p:P166 ps:P166 "win") (p:P1411 ps:P1411 "nomination") }
          ?title ?p ?statement. ?statement ?ps ?award. OPTIONAL { ?statement pq:P585 ?date }
          ?award rdfs:label ?label. FILTER(LANG(?label)="en") FILTER(CONTAINS(LCASE(?label), "primetime emmy")) }` : ''}
          SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
        } LIMIT 100`;
        const data = await get('Wikidata', 'https://query.wikidata.org/sparql', { query, format: 'json' }, state);
        const result = { emmys: [] };
        const currencies = { 'United States dollar': 'USD', 'US dollar': 'USD', 'euro': 'EUR', 'pound sterling': 'GBP', 'Japanese yen': 'JPY', 'Indian rupee': 'INR', 'Canadian dollar': 'CAD', 'Australian dollar': 'AUD' };
        for (const row of list(data?.results?.bindings)) {
            const kind = row.kind?.value;
            if (kind === 'budget' || kind === 'boxOffice') {
                const currency = currencies[row.unitLabel?.value];
                if (currency && !result[kind]) result[kind] = money(Number(row.amount?.value), currency);
            } else if (kind === 'studio') result.studio ||= text(row.label?.value);
            else if (kind === 'win' || kind === 'nomination') result.emmys.push({ kind, category: text(row.label?.value), statement: row.statement?.value, year: row.date?.value?.slice(0, 4) });
        }
        return result;
    }

    async function resolveTitle(id, log = logger, providedMovie) {
        const key = contextKey(id), cached = cache.get(key);
        if (cached) return cached;
        return once(key, async () => {
            const state = { partial: false, deadline: Date.now() + 12000 };
            const movie = providedMovie || await omdbGet({ i: id }, state);
            if (!movie) return { unavailable: true, partial: state.partial, movie: null, seasons: [] };
            const isTV = movie.Type === 'series';
            let tmdb = null, tmdbId = null, maze = null;
            const found = await tmdbGet(`find/${id}`, state, { external_source: 'imdb_id' });
            // OMDb Type is authoritative; never take movie_results for a series.
            const match = isTV ? found?.tv_results?.[0] : found?.movie_results?.[0];
            if (match?.id) { tmdbId = match.id; tmdb = await tmdbGet(`${isTV ? 'tv' : 'movie'}/${tmdbId}`, state, { append_to_response: 'credits' }); }
            if (isTV && settings().maze) maze = await get('TVMaze', 'https://api.tvmaze.com/lookup/shows', { imdb: id }, state);
            let seasons = list(tmdb?.seasons).filter(Boolean).map(s => ({ number: s.season_number, episodeCount: s.episode_count, airDate: s.air_date, source: 'TMDB' }));
            let mazeSeasons = [];
            if (isTV && maze?.id) {
                mazeSeasons = list(await get('TVMaze', `https://api.tvmaze.com/shows/${maze.id}/seasons`, {}, state)).filter(Boolean);
                for (const s of mazeSeasons) {
                    const current = seasons.find(item => item.number === s.number);
                    if (current) { current.mazeId = s.id; current.episodeCount ||= s.episodeOrder; }
                    else seasons.push({ number: s.number, episodeCount: s.episodeOrder, airDate: s.premiereDate, mazeId: s.id, source: 'TVMaze' });
                }
            }
            if (isTV && !seasons.length) {
                const count = Math.min(200, Math.floor(positive(movie.totalSeasons) || 0));
                seasons = Array.from({ length: count }, (_, i) => ({ number: i + 1, episodeCount: null, source: 'OMDb' }));
            }
            seasons = seasons.filter(s => Number.isInteger(s.number) && s.number >= 0 && s.number <= 200).sort((a, b) => a.number - b.number);
            const context = { movie, isTV, tmdb, tmdbId, maze, seasons, partial: state.partial };
            log.info({ imdbId: id, mediaType: isTV ? 'tv' : 'movie', seasonCount: seasons.length, event: 'title_resolved' }, 'Title providers resolved');
            return remember(key, context);
        });
    }

    function normalizeEpisodes(data, source, n) {
        const list = source === 'TMDB' ? data?.episodes : source === 'OMDb' ? data?.Episodes : data;
        if (!Array.isArray(list)) return [];
        return list.filter(e => e && typeof e === 'object').map((e, index) => {
            const number = Number(source === 'TMDB' ? e.episode_number : source === 'OMDb' ? e.Episode : e.number);
            const special = n === 0 || source === 'TVMaze' && (e.type === 'significant_special' || e.type === 'insignificant_special' || !e.number);
            const runtime = positive(e.runtime || (typeof e.Runtime === 'string' ? parseInt(e.Runtime, 10) : null));
            const rating = source === 'OMDb' ? positive(e.imdbRating) : source === 'TMDB' ? (positive(e.vote_count) ? positive(e.vote_average) : null) : positive(e.rating?.average);
            const rawDate = source === 'OMDb' ? e.Released : e.air_date || e.airdate;
            const parsedDate = Date.parse(rawDate);
            return {
                number: special ? number || index + 1 : number, season: n, special,
                title: text(e.name || e.Title), airDate: Number.isFinite(parsedDate) ? new Date(parsedDate).toISOString().slice(0, 10) : null,
                airTimestamp: e.airstamp || null, runtime, rating, ratingSource: rating ? (source === 'OMDb' ? 'IMDb via OMDb' : source) : null,
                image: image(source === 'TMDB' && e.still_path ? `https://image.tmdb.org/t/p/w300${e.still_path}` : e.image?.medium || e.image?.original),
                plot: text(e.overview || e.summary || e.Plot), sources: { runtime: runtime ? source : null, metadata: source, title: source, airDate: source, airTimestamp: source, image: source, plot: source }
            };
        }).filter(e => Number.isInteger(e.number) && e.number > 0);
    }

    function mergeEpisodes(primary, fallback) {
        const result = new Map(primary.map(e => [`${e.special ? 'special' : 'regular'}:${e.number}`, { ...e, sources: { ...e.sources } }]));
        for (const episode of fallback) {
            const key = `${episode.special ? 'special' : 'regular'}:${episode.number}`;
            const existing = result.get(key);
            if (!existing) { result.set(key, episode); continue; }
            for (const field of ['title', 'airDate', 'airTimestamp', 'runtime', 'image', 'plot']) if (!present(existing[field]) && present(episode[field])) {
                existing[field] = episode[field]; existing.sources[field] = episode.sources[field] || episode.sources.metadata;
            }
            if (episode.rating && (!existing.rating || episode.ratingSource === 'IMDb via OMDb')) { existing.rating = episode.rating; existing.ratingSource = episode.ratingSource; }
        }
        return [...result.values()].sort((a, b) => Number(a.special) - Number(b.special) || a.number - b.number);
    }

    async function getSeason(id, n, context, { deadline = Date.now() + 12000, enrich = false } = {}) {
        const key = seasonKey(id, n);
        // A user retry should reattempt failed providers immediately; successful
        // warmed season responses still avoid duplicate requests.
        const saved = cache.get(key), cached = enrich && saved?.partial ? null : saved;
        if (cached && (!enrich || cached.omdbChecked || !settings().omdb)) return cached;
        return once(key, async () => {
            const state = { partial: false, deadline };
            const season = context.seasons.find(s => s.number === n);
            if (!season) return { number: n, episodes: [], notFound: true, partial: false };
            let episodes = cached?.episodes || [];
            let providerFound = Boolean(cached && !cached.unavailable);
            if (!cached) {
                const tmdb = context.tmdbId ? await tmdbGet(`tv/${context.tmdbId}/season/${n}`, state) : null;
                if (tmdb) { episodes = normalizeEpisodes(tmdb, 'TMDB', n); providerFound = true; }
                const needsFallback = !episodes.length || episodes.some(e => !e.runtime || !e.plot || !e.airDate || !e.image) || positive(season.episodeCount) > episodes.filter(e => !e.special).length;
                if (needsFallback && season.mazeId && settings().maze) {
                    const maze = await get('TVMaze', `https://api.tvmaze.com/seasons/${season.mazeId}/episodes`, {}, state);
                    if (maze) { episodes = mergeEpisodes(episodes, normalizeEpisodes(maze, 'TVMaze', n)); providerFound = true; }
                }
                if (n === 0 && !episodes.length && context.maze?.id && settings().maze) {
                    const maze = await get('TVMaze', `https://api.tvmaze.com/shows/${context.maze.id}/episodes`, { specials: 1 }, state);
                    if (maze) {
                        const specials = list(maze).filter(e => e && (!e.number || /special/.test(e.type || '')));
                        episodes = normalizeEpisodes(specials, 'TVMaze', 0); providerFound = true;
                    }
                }
                if (n > 0 && episodes.some(e => e.special)) {
                    if (!context.seasons.some(s => s.number === 0)) context.seasons.push({ number: 0, episodeCount: null, source: 'TVMaze' });
                    episodes = episodes.filter(e => !e.special);
                }
            }
            let omdbChecked = Boolean(cached?.omdbChecked);
            if ((enrich || !episodes.length) && n > 0 && settings().omdb) {
                const omdb = await omdbGet({ i: id, Season: n }, state);
                omdbChecked = !state.partial;
                if (omdb) { episodes = mergeEpisodes(episodes, normalizeEpisodes(omdb, 'OMDb', n)); providerFound = true; }
            }
            const partial = state.partial || Boolean(cached?.partial) || !providerFound || positive(season.episodeCount) > episodes.length;
            const result = { number: n, episodes, partial, unavailable: !providerFound, omdbChecked };
            logger.info({ imdbId: id, season: n, episodes: episodes.length, partial, event: 'season_loaded' }, 'Season data assembled');
            // A lazy ratings upgrade shares the SAME episode cache without renewing its hour.
            const ttl = cached ? Math.min(cache.getRemainingTTL(key), partial ? PARTIAL_TTL : HOUR) : partial ? PARTIAL_TTL : HOUR;
            cache.set(key, result, { ttl: Math.max(1, ttl) });
            return result;
        });
    }

    async function enrichMovie(movie, log = logger) {
        const id = movie.imdbID;
        const context = validId(id) ? await resolveTitle(id, log, movie) : { movie, isTV: movie.Type === 'series', seasons: [], partial: false };
        const state = { partial: context.partial, deadline: Date.now() + 12000 };
        const tmdb = context.tmdb, maze = context.maze;
        const emmys = context.isTV ? parseEmmys(movie.Awards) : null;
        const needsWiki = (!context.isTV && (!money(movie.BoxOffice) && !positive(tmdb?.revenue) || !positive(tmdb?.budget))) || (!tmdb?.production_companies?.length && !tmdb?.networks?.length && !maze?.network && !maze?.webChannel && !present(movie.Production)) || context.isTV && !emmys;
        const wikiPromise = needsWiki ? wikidata(id, state, context.isTV && !emmys) : Promise.resolve({});
        let detailedCast = list(tmdb?.credits?.cast).filter(Boolean).slice(0, 8).map(actor => ({ ...actor, name: text(actor.name), character: text(actor.character), image: image(actor.profile_path ? `https://image.tmdb.org/t/p/w185${actor.profile_path}` : null), source: 'TMDB' }));
        if (context.isTV && !detailedCast.length && maze?.id) {
            const cast = await get('TVMaze', `https://api.tvmaze.com/shows/${maze.id}/cast`, {}, state);
            detailedCast = list(cast).filter(Boolean).slice(0, 8).map(actor => ({ name: text(actor.person?.name), character: text(actor.character?.name), image: image(actor.person?.image?.medium), source: 'TVMaze' }));
        }
        const seasonResults = context.isTV ? await mapLimit(context.seasons.filter(s => s.number > 0), 4, season => getSeason(id, season.number, context, { deadline: state.deadline })) : [];
        const wiki = await wikiPromise;
        const pick = (entries) => aggregateMetric(entries.map(([source, value]) => ({ source, get: () => value })), log);
        const metrics = {
            boxOffice: await pick([['OMDb', money(movie.BoxOffice)], ['TMDB', money(tmdb?.revenue)], ['Wikidata', wiki.boxOffice]]),
            budget: await pick([['TMDB', money(tmdb?.budget)], ['Wikidata', wiki.budget]]),
            studio: await pick([['TMDB', text(context.isTV ? tmdb?.networks?.[0]?.name || tmdb?.production_companies?.[0]?.name : tmdb?.production_companies?.[0]?.name)], ['TVMaze', text(maze?.network?.name || maze?.webChannel?.name)], ['Wikidata', wiki.studio], ['OMDb', movie.Production]]),
            status: await pick([['TMDB', tmdb?.status], ['TVMaze', maze?.status]]),
            firstAirDate: await pick([['TMDB', tmdb?.first_air_date], ['TVMaze', maze?.premiered], ['OMDb', movie.Released]]),
            lastAirDate: await pick([['TMDB', tmdb?.last_air_date], ['TVMaze', maze?.ended]])
        };
        const scores = [];
        const addScore = (label, value, max, source, votes) => { if (positive(value) && Number(value) <= max) scores.push({ label, value: Number(value), max, source, votes: votes || null }); };
        const imdbScore = list(movie.Ratings).find(r => r?.Source === 'Internet Movie Database');
        addScore('IMDb', positive(movie.imdbRating) || (imdbScore ? parseFloat(imdbScore.Value) : null), 10, 'OMDb', movie.imdbVotes);
        const rt = list(movie.Ratings).find(r => r?.Source === 'Rotten Tomatoes');
        addScore('Tomatometer', rt ? parseFloat(rt.Value) : null, 100, 'OMDb');
        const meta = list(movie.Ratings).find(r => r?.Source === 'Metacritic');
        addScore('Metacritic', positive(movie.Metascore) || (meta ? parseFloat(meta.Value) : null), 100, 'OMDb');
        if (positive(tmdb?.vote_count)) addScore('TMDB', tmdb?.vote_average, 10, 'TMDB', tmdb?.vote_count);
        if (context.isTV) addScore('TVMaze', maze?.rating?.average, 10, 'TVMaze');
        let honors = emmys;
        if (!honors && wiki.emmys?.length) {
            const records = [...new Map(wiki.emmys.map(row => [row.statement, row])).values()];
            honors = { wins: records.filter(r => r.kind === 'win').length || null, nominations: records.filter(r => r.kind === 'nomination').length || null, source: 'Wikidata', recorded: true, categories: records.map(r => `${r.category}${r.year ? ' (' + r.year + ')' : ''}`) };
        }
        const posters = [metric(image(movie.Poster), 'OMDb'), metric(image(tmdb?.poster_path ? `https://image.tmdb.org/t/p/w500${tmdb.poster_path}` : null), 'TMDB'), metric(image(maze?.image?.original || maze?.image?.medium), 'TVMaze')].filter(p => p.value);
        const stats = context.isTV ? computeTVStats(context, seasonResults) : null;
        const partial = state.partial || context.partial || stats?.partial || seasonResults.some(s => s.partial);
        return { ...movie, Metrics: metrics, Scores: scores, Emmys: honors, DetailedCast: detailedCast, Poster: posters[0]?.value || null, PosterSources: posters, TV: context.isTV ? { seasons: context.seasons, ...stats } : null, Partial: Boolean(partial) };
    }
    return { resolveTitle, getSeason, enrichMovie, remember, settings, cooldowns };
}

module.exports = { createAggregation, aggregateMetric, computeTVStats, parseEmmys, formatWatchTime, money, aired, validId, present, image, metric, mapLimit, searchKey, contextKey, seasonKey, HOUR, PARTIAL_TTL };
