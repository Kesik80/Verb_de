module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  const token = process.env.GH_TOKEN;

  try {
    const headers = {
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'verb-de-app',
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const r = await fetch(
      'https://api.github.com/repos/Kesik80/Verb_de/contents/woerterbuch.json',
      { headers }
    );

    if (!r.ok) {
      return res.status(r.status).json({ error: `GitHub: ${r.status}` });
    }

    const data = await r.json();
    // Decode base64 content
    const bytes = Buffer.from(data.content.replace(/\s/g, ''), 'base64');
    const json = JSON.parse(bytes.toString('utf-8'));

    return res.status(200).json(json);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
