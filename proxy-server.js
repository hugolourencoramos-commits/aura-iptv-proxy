import express from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 3000;

const corsOptions = {
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions)); // handle preflight for all routes
app.use(express.json());

// ─── Helpers ──────────────────────────────────────────────────────────────────
function cleanUrl(serverUrl) {
  return serverUrl.replace(/\/+$/, "");
}

function playerApi(serverUrl, username, password, params = "") {
  return `${cleanUrl(serverUrl)}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}${params}`;
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout
  try {
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok) throw new Error(`Upstream error: ${response.status}`);
    return response.json();
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === "AbortError") throw new Error("Request to IPTV server timed out.");
    throw err;
  }
}

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ ok: true, service: "Aura IPTV Proxy" });
});

// ─── Account info ─────────────────────────────────────────────────────────────
app.post("/api/account", async (req, res) => {
  try {
    const { serverUrl, username, password } = req.body;
    if (!serverUrl || !username || !password)
      return res.status(400).json({ error: "Missing serverUrl, username or password." });

    const data = await fetchJson(playerApi(serverUrl, username, password));
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── All content (categories + items) for one type ───────────────────────────
app.post("/api/content", async (req, res) => {
  try {
    const { serverUrl, username, password, type } = req.body;
    if (!serverUrl || !username || !password || !type)
      return res.status(400).json({ error: "Missing required fields." });

    const actions = {
      live:   { cat: "get_live_categories",  items: "get_live_streams" },
      movies: { cat: "get_vod_categories",   items: "get_vod_streams"  },
      series: { cat: "get_series_categories", items: "get_series"      }
    };

    const a = actions[type];
    if (!a) return res.status(400).json({ error: "Invalid type." });

    const [categories, items] = await Promise.all([
      fetchJson(playerApi(serverUrl, username, password, `&action=${a.cat}`)),
      fetchJson(playerApi(serverUrl, username, password, `&action=${a.items}`))
    ]);

    res.json({
      categories: Array.isArray(categories) ? categories : [],
      items:      Array.isArray(items)      ? items      : []
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Content by type (memory-safe — one type at a time) ──────────────────────
// Replaces /api/content/all which caused OOM on free tier
// Call separately for each type: live, movies, series

// ─── VOD info (movie detail) ──────────────────────────────────────────────────
app.post("/api/vod-info", async (req, res) => {
  try {
    const { serverUrl, username, password, vodId } = req.body;
    if (!serverUrl || !username || !password || !vodId)
      return res.status(400).json({ error: "Missing required fields." });

    const data = await fetchJson(
      playerApi(serverUrl, username, password, `&action=get_vod_info&vod_id=${encodeURIComponent(vodId)}`)
    );
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Series info (seasons + episodes) ────────────────────────────────────────
app.post("/api/series-info", async (req, res) => {
  try {
    const { serverUrl, username, password, seriesId } = req.body;
    if (!serverUrl || !username || !password || !seriesId)
      return res.status(400).json({ error: "Missing required fields." });

    const data = await fetchJson(
      playerApi(serverUrl, username, password, `&action=get_series_info&series_id=${encodeURIComponent(seriesId)}`)
    );
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Stream proxy (resolves CORS for HLS + video files) ──────────────────────
// Usage: GET /api/stream?url=<encoded_stream_url>
app.get("/api/stream", async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: "Missing url parameter." });

    const decodedUrl = decodeURIComponent(url);
    const isM3u8 = decodedUrl.includes(".m3u8") || decodedUrl.includes("m3u8");

    const upstream = await fetch(decodedUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; AuraIPTV/1.0)",
        "Accept": "*/*"
      }
    });

    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: `Upstream error: ${upstream.status}` });
    }

    const contentType = upstream.headers.get("content-type") || 
      (isM3u8 ? "application/vnd.apple.mpegurl" : "video/mp2t");

    res.setHeader("Content-Type", contentType);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");

    // M3U8 playlist — rewrite segment URLs through proxy
    if (isM3u8) {
      const text = await upstream.text();
      const baseUrl = decodedUrl.substring(0, decodedUrl.lastIndexOf("/") + 1);

      const rewritten = text.split("\n").map(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) return line;
        const absoluteUrl = trimmed.startsWith("http") ? trimmed : baseUrl + trimmed;
        return `/api/stream?url=${encodeURIComponent(absoluteUrl)}`;
      }).join("\n");

      return res.send(rewritten);
    }

    // Binary segments (TS, MP4, etc.) — stream via pipe, don't buffer
    const { Readable } = await import("stream");
    const nodeStream = Readable.fromWeb(upstream.body);
    
    // Forward content-length if available
    const contentLength = upstream.headers.get("content-length");
    if (contentLength) res.setHeader("Content-Length", contentLength);

    nodeStream.pipe(res);
    nodeStream.on("error", (err) => {
      console.error("Stream pipe error:", err.message);
      if (!res.headersSent) res.status(500).end();
    });

  } catch (error) {
    console.error("Stream error:", error.message);
    if (!res.headersSent) res.status(500).json({ error: error.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Aura IPTV proxy running on port ${PORT}`);
});
