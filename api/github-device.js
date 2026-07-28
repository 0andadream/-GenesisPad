/**
 * Proxy GitHub device-flow OAuth so the browser can obtain a gist-scoped token
 * without CORS issues (github.com/login/* does not allow browser origins).
 */

const CLIENT_ID = "178c6fc778ccc68e1d6a"; // GitHub CLI public client id

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
  res.setHeader("Cache-Control", "no-store");
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }

  try {
    const body = typeof req.body === "string"
      ? JSON.parse(req.body || "{}")
      : (req.body || {});
    const step = body.step || "code";

    if (step === "code") {
      const response = await fetch("https://github.com/login/device/code", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: CLIENT_ID,
          scope: "gist",
        }),
      });
      const data = await response.json();
      res.status(response.ok ? 200 : 400).json(data);
      return;
    }

    if (step === "token") {
      if (!body.device_code) {
        res.status(400).json({ error: "device_code required" });
        return;
      }
      const response = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: CLIENT_ID,
          device_code: body.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      });
      const data = await response.json();
      res.status(response.ok ? 200 : 400).json(data);
      return;
    }

    res.status(400).json({ error: "Unknown step" });
  } catch (reason) {
    res.status(500).json({
      error: reason instanceof Error ? reason.message : "device flow failed",
    });
  }
};
