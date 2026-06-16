const express = require('express');
const axios = require('axios');
require('dotenv').config();
const app = express();

const fs = require('fs');
const path = require('path');

let oscarData = [];

async function loadOscarData() {
    const localPath = path.join(__dirname, 'oscar-nominations.json');
    try {
        if (fs.existsSync(localPath)) {
            console.log('[OSCAR] Loading local Oscar database...');
            const rawData = fs.readFileSync(localPath, 'utf8');
            oscarData = JSON.parse(rawData);
            console.log(`[OSCAR] Success! Loaded ${oscarData.length} nominations from local file.`);
        } else {
            console.log('[OSCAR] Local database not found. Fetching from GitHub...');
            const response = await axios.get('https://raw.githubusercontent.com/delventhalz/json-nominations/master/oscar-nominations.json');
            oscarData = response.data;
            fs.writeFileSync(localPath, JSON.stringify(oscarData, null, 2), 'utf8');
            console.log(`[OSCAR] Success! Loaded and saved ${oscarData.length} nominations from GitHub.`);
        }
    } catch (error) {
        console.error(`[OSCAR] Error loading database: ${error.message}`);
    }
}
loadOscarData();

app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.json()); // Enable JSON parsing for frontend logs

const API_KEY = process.env.OMDB_API_KEY;

// Endpoint to catch client-side errors and print them to the terminal
app.post('/log', (req, res) => {
    console.error(`[CLIENT ERROR] ${req.body.message}`);
    res.sendStatus(200);
});

app.get('/', (req, res) => {
    res.render('index', { movie: null, error: null });
});

app.get('/search', async (req, res) => {
    const movieTitle = req.query.title;
    console.log(`\n--- NEW SEARCH: "${movieTitle}" ---`);
    try {
        console.log(`[OMDB] Fetching data for: ${movieTitle}`);
        const response = await axios.get('http://www.omdbapi.com/', {
            params: {
                t: movieTitle,
                apikey: API_KEY
            }
        });
        
        if (response.data.Response === "False") {
            console.warn(`[OMDB] Movie not found: ${movieTitle}`);
            res.render('index', { movie: null, error: "Movie not found!" });
        } else {
            console.log(`[OMDB] Success! Found: ${response.data.Title} (${response.data.Year})`);
            let castData = [];
            try {
                const imdbId = response.data.imdbID;
                if (imdbId && imdbId !== "N/A") {
                    console.log(`[TMDB] Fetching TMDB ID using IMDb ID: ${imdbId}`);
                    const tmdbKey = process.env.TMDB_API_KEY;
                    // 1. Get TMDB internal ID using the IMDb ID
                    const findRes = await axios.get(`https://api.themoviedb.org/3/find/${imdbId}`, {
                        params: {
                            external_source: 'imdb_id',
                            api_key: tmdbKey
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
                        console.log(`[TMDB] Found TMDB ID: ${tmdbId} (isMovie: ${isMovie}). Fetching cast credits...`);
                        const mediaType = isMovie ? 'movie' : 'tv';
                        const creditsRes = await axios.get(`https://api.themoviedb.org/3/${mediaType}/${tmdbId}/credits`, {
                            params: {
                                api_key: tmdbKey
                            }
                        });
                        castData = creditsRes.data.cast.slice(0, 8); // Grab up to Top 8 actors
                        console.log(`[TMDB] Success! Fetched ${castData.length} cast members.`);
 
                        // Attach TMDB user rating data to response
                        response.data.tmdbRating = tmdbMovie.vote_average;
                        response.data.tmdbVoteCount = tmdbMovie.vote_count;
                    } else {
                        console.warn(`[TMDB] No TMDB results found for IMDb ID: ${imdbId}`);
                    }
                } else {
                    console.warn(`[OMDB] No valid IMDb ID returned. Cannot fetch TMDB cast images.`);
                }
            } catch (tmdbError) {
                console.error(`[TMDB] API Fetch Error: ${tmdbError.message}`);
                // Fail gracefully so the OMDB data still loads
            }

            // Filter Oscar awards for this movie
            let oscars = [];
            const imdbId = response.data.imdbID;
            console.log(`[DEBUG SEARCH] Movie: "${response.data.Title}", IMDb ID: "${imdbId}", cached oscarData size: ${oscarData.length}`);
            if (imdbId && imdbId !== "N/A" && oscarData.length > 0) {
                oscars = oscarData.filter(item => 
                    item.movies && item.movies.some(m => m.imdb_id === imdbId)
                );
            }
            console.log(`[DEBUG SEARCH] Found ${oscars.length} Oscar entries.`);
            response.data.Oscars = oscars;

            response.data.DetailedCast = castData;
            res.render('index', { movie: response.data, error: null });
        }
    } catch (error) {
        console.error(`[OMDB] Fatal API Fetch Error: ${error.message}`);
        res.render('index', { movie: null, error: "Error fetching data." });
    }
});

app.listen(3000, () => console.log('Server running at http://localhost:3000'));