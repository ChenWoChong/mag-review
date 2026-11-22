import { startServer } from './server.js';
import { importHistory } from './history-import.js';

// A short-lived Magpie CLI host can briefly hold the page port while the app
// is restarting its plugin host. Keep retrying instead of silently giving up.
export async function startPageService(options, start = startServer, retryMs = 1000) {
  try {
    await start(options);
  } catch (error) {
    if (error?.code !== 'EADDRINUSE') throw error;
    const retry = async () => {
      try {
        await start(options);
      } catch (nextError) {
        if (nextError?.code !== 'EADDRINUSE') {
          console.error('[prompt-diary] page service could not start:', nextError?.message || nextError);
          return;
        }
        const timer = setTimeout(retry, retryMs);
        timer.unref?.();
      }
    };
    const timer = setTimeout(retry, retryMs);
    timer.unref?.();
  }
}

export default {
  id: 'magpie-prompt-diary',
  server: async (_input, options) => {
    if (process.env.MAGPIE_PROMPT_IMPORT_CHILD === '1') return {};
    await startPageService(options);
    importHistory(options).catch((error) => {
      console.error('[prompt-diary] history import failed:', error?.message || error);
    });
    return {};
  },
};
