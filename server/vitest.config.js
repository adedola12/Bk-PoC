import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // pdfjs-dist and exceljs both spawn native-ish workers; parallel vitest
    // forks intermittently die with ERR_IPC_CHANNEL_CLOSED on Windows.
    fileParallelism: false,
    testTimeout: 30000,
  },
});
