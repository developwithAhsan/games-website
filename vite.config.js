import { defineConfig } from "vite";
import { Readable } from "stream";

function gameDownloadPlugin() {
  return {
    name: "game-download-proxy",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url.startsWith("/proxy-game-download")) {
          return next();
        }

        const candidateUrls = [
          "https://gta-proxy.editingking-2977.workers.dev",
          "https://ia801606.us.archive.org/0/items/gta-vicecity-wasm-assets/vc-assets.tar.gz",
          "https://ia601606.us.archive.org/25/items/gta-vicecity-wasm-assets/vc-assets.tar.gz",
          "https://drive.usercontent.google.com/download?id=1_SDUPGPfISA_GGUgbS0RQYA53RQnehNo&export=download&confirm=t"
        ];

        const headers = {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        };
        if (req.headers.range) {
          headers["Range"] = req.headers.range;
        }

        try {
          let upstream = null;
          for (const candidate of candidateUrls) {
            try {
              console.log("[game-proxy] attempting download from candidate:", candidate);
              const resCandidate = await fetch(candidate, {
                redirect: "follow",
                headers,
              });
              const cType = resCandidate.headers.get("content-type") || "";
              if ((resCandidate.ok || resCandidate.status === 206) && !cType.includes("text/html")) {
                upstream = resCandidate;
                console.log("[game-proxy] candidate succeeded:", candidate);
                break;
              } else {
                console.warn(`[game-proxy] candidate returned invalid status ${resCandidate.status} or type ${cType}`);
              }
            } catch (err) {
              console.warn(`[game-proxy] error fetching ${candidate}:`, err.message);
            }
          }

          if (!upstream) {
            res.statusCode = 502;
            res.end("Upstream error: All download sources failed");
            return;
          }

          res.statusCode = upstream.status;
          res.setHeader(
            "content-type",
            upstream.headers.get("content-type") || "application/octet-stream",
          );
          res.setHeader("access-control-allow-origin", "*");
          res.setHeader("cross-origin-resource-policy", "cross-origin");
          res.setHeader("accept-ranges", "bytes");

          const contentLength = upstream.headers.get("content-length");
          if (contentLength) {
            res.setHeader("content-length", contentLength);
          }
          const contentRange = upstream.headers.get("content-range");
          if (contentRange) {
            res.setHeader("content-range", contentRange);
          }

          res.flushHeaders();

          if (req.method === "HEAD") {
            res.end();
            return;
          }

          const nodeStream = Readable.fromWeb(upstream.body);
          nodeStream.pipe(res);
          nodeStream.on("error", (err) => {
            console.error("[game-proxy] stream error:", err.message);
          });
          res.on("close", () => {
            nodeStream.destroy();
          });

        } catch (err) {
          console.error("[game-proxy] error:", err.message);
          if (!res.headersSent) {
            res.statusCode = 502;
            res.end(`Proxy error: ${err.message}`);
          }
        }
      });
    },
  };
}

export default defineConfig({
  base: "/",
  plugins: [gameDownloadPlugin()],
  define: {
    __IS_VERCEL__: JSON.stringify(!!process.env.VERCEL),
    __IS_REPLIT__: JSON.stringify(!!process.env.REPL_ID),
  },
  server: {
    host: "0.0.0.0",
    port: 3000,
    allowedHosts: true,
  },
});
