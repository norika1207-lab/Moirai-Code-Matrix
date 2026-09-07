// 獨立啟動 Node.js 版 server(不透過 Electron)，方便開發時測試，也可當作 CLI fallback。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HERE = path.join(__dirname, '..');
const port = parseInt(process.env.DUO_PORT || '8765', 10);

startServer({ HERE, port }).catch((e) => {
  console.error('server start failed', e);
  process.exit(1);
});
