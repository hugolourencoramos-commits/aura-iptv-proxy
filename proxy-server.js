import express from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

function buildPlayerApiUrl(serverUrl, username, password, action) {
  const cleanServer = serverUrl.replace(/\/+$/, "");
  return `${cleanServer}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&action=${action}`;
}

function buildAccountUrl(serverUrl, username, password) {
  const cleanServer = serverUrl.replace(/\/+$/, "");
  return `${cleanServer}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;
}

app.get("/", (req, res) => {
  res.json({ ok: true, service: "Aura IPTV Proxy" });
});

app.post("/api/account", async (req, res) => {
  try {
    const { serverUrl, username, password } = req.body;

    if (!serverUrl || !username || !password) {
      return res.status(400).json({ error: "Missing serverUrl, username or password." });
    }

    const response = await fetch(buildAccountUrl(serverUrl, username, password));
    const data = await response.json();

    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message || "Failed to fetch account info." });
  }
});

app.post("/api/content", async (req, res) => {
  try {
    const { serverUrl, username, password, type } = req.body;

    if (!serverUrl || !username || !password || !type) {
      return res.status(400).json({ error: "Missing serverUrl, username, password or type." });
    }

    let categoryAction = "get_live_categories";
    let contentAction = "get_live_streams";

    if (type === "movies") {
      categoryAction = "get_vod_categories";
      contentAction = "get_vod_streams";
    }

    if (type === "series") {
      categoryAction = "get_series_categories";
      contentAction = "get_series";
    }

    const [categoriesRes, contentRes] = await Promise.all([
      fetch(buildPlayerApiUrl(serverUrl, username, password, categoryAction)),
      fetch(buildPlayerApiUrl(serverUrl, username, password, contentAction))
    ]);

    const categories = await categoriesRes.json();
    const items = await contentRes.json();

    res.json({
      categories: Array.isArray(categories) ? categories : [],
      items: Array.isArray(items) ? items : []
    });
  } catch (error) {
    res.status(500).json({ error: error.message || "Failed to fetch content." });
  }
});

app.listen(PORT, () => {
  console.log(`Aura IPTV proxy running on port ${PORT}`);
});