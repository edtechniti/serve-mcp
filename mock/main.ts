/**
 * Run the mock Serve API locally: `npm run mock`.
 */
import { startMockServer } from "./server.js";

const port = Number(process.env.MOCK_PORT ?? 4010);
const apiKey = process.env.MOCK_API_KEY;

const mock = await startMockServer({ port, ...(apiKey ? { apiKey } : {}) });
console.error(`Mock Serve API listening on ${mock.url} (partner id: any, e.g. ptnr_mock)`);

const stop = (): void => {
  void mock.close().then(() => process.exit(0));
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
