// Use deterministic dummy credentials; route tests must not depend on a local .env file.
process.env.OMDB_API_KEY = 'test-omdb';
process.env.TMDB_API_KEY = '';

// All test suites are offline. Unexpected HTTP is a test failure, not a live call.
jest.mock('axios', () => ({
    create: () => ({ get: jest.fn(() => { throw new Error('Unexpected external HTTP call in offline tests'); }) })
}));
