// All test suites are offline. Unexpected HTTP is a test failure, not a live call.
jest.mock('axios', () => ({
    create: () => ({ get: jest.fn(() => { throw new Error('Unexpected external HTTP call in offline tests'); }) })
}));
