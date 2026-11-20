// Test servers on a free port that fetch() can reach.
// fetch() (undici) refuses the Fetch standard's "bad ports" (6000, 6665, 10080…). Port 0 lets the system pick, and some
// systems pick from a range that includes them (Windows can be set to hand out ports from 1024 up), so a test server
// could land where fetch won't go and the test would fail at random. Rebind until the port is one fetch accepts.
import http from 'node:http';

const BAD_PORTS = new Set([1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104,
  109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540,
  548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665,
  6666, 6667, 6668, 6669, 6679, 6697, 10080]);

export const isBadPort = port => BAD_PORTS.has(Number(port));

/** server.listen(0, host) until the port isn't a bad one; resolves with the server. An Express app gets its own server. */
export async function listen(serverOrApp, host = '127.0.0.1') {
  const server = typeof serverOrApp.address === 'function' ? serverOrApp : http.createServer(serverOrApp);
  for (;;) {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, host, () => { server.off('error', reject); resolve(); });
    });
    if (!isBadPort(server.address().port)) return server;
    await new Promise(resolve => server.close(resolve));
  }
}
