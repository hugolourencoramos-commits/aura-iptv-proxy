import express from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ─── Helpers ──────────────────────────────────────────────────────────────────
function cleanUrl(serverUrl) {
  return serverUrl.replace(/\/+$/, "");
}

function playerApi(serverUrl, username, password, params = "") {
  return `${cleanUrl(serverUrl)}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}${params}`;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Upstream error: ${response.status}`);
  return response.json();
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

// ─── All content at once (live + movies + series) ────────────────────────────
app.post("/api/content/all", async (req, res) => {
  try {
    const { serverUrl, username, password } = req.body;
    if (!serverUrl || !username || !password)
      return res.status(400).json({ error: "Missing required fields." });

    const [
      liveCats, liveItems,
      movieCats, movieItems,
      seriesCats, seriesItems
    ] = await Promise.all([
      fetchJson(playerApi(serverUrl, username, password, "&action=get_live_categories")),
      fetchJson(playerApi(serverUrl, username, password, "&action=get_live_streams")),
      fetchJson(playerApi(serverUrl, username, password, "&action=get_vod_categories")),
      fetchJson(playerApi(serverUrl, username, password, "&action=get_vod_streams")),
      fetchJson(playerApi(serverUrl, username, password, "&action=get_series_categories")),
      fetchJson(playerApi(serverUrl, username, password, "&action=get_series"))
    ]);

    res.json({
      live:   { categories: Array.isArray(liveCats)    ? liveCats    : [], items: Array.isArray(liveItems)    ? liveItems    : [] },
      movies: { categories: Array.isArray(movieCats)   ? movieCats   : [], items: Array.isArray(movieItems)   ? movieItems   : [] },
      series: { categories: Array.isArray(seriesCats)  ? seriesCats  : [], items: Array.isArray(seriesItems)  ? seriesItems  : [] }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

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

    const upstream = await fetch(decodedUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; AuraIPTV/1.0)"
      }
    });

    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: `Upstream error: ${upstream.status}` });
    }

    // Forward content-type and other relevant headers
    const contentType = upstream.headers.get("content-type") || "application/octet-stream";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Access-Control-Allow-Origin", "*");

    // For m3u8 playlists, rewrite segment URLs to go through proxy too
    if (contentType.includes("mpegurl") || decodedUrl.includes(".m3u8")) {
      const text = await upstream.text();
      const baseUrl = decodedUrl.substring(0, decodedUrl.lastIndexOf("/") + 1);

      const rewritten = text.split("\n").map(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) return line;
        // Rewrite relative segment URLs to absolute, then proxy them
        const absoluteUrl = trimmed.startsWith("http")
          ? trimmed
          : baseUrl + trimmed;
        return `/api/stream?url=${encodeURIComponent(absoluteUrl)}`;
      }).join("\n");

      res.send(rewritten);
    } else {
      // Binary stream — pipe directly
      const buffer = await upstream.arrayBuffer();
      res.send(Buffer.from(buffer));
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Aura IPTV proxy running on port ${PORT}`);
});
