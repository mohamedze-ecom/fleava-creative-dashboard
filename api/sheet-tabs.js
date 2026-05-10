// Returns all tabs (gid + label) for a public Google Sheet by parsing the
// embedded JSON in the /edit page. Used by the front-end so newly added month
// tabs are picked up automatically without a redeploy.
export default async function handler(req, res) {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'Sheet ID required' });
  try {
    const url = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}/edit`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        // Pretend to be a regular browser so Google returns the full HTML.
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      },
    });
    clearTimeout(timeout);
    if (!response.ok) throw new Error(`Google returned ${response.status}`);
    const html = await response.text();

    // Tabs are embedded in a JSON-encoded string like:
    //   [11,0,\"1983517648\",[{\"1\":[[0,0,\"April 2026\"], ...
    // The backslash-quotes are literal characters in the HTML body.
    const tabs = [];
    const seen = new Set();
    const re = /\[\d+,0,\\"(\d+)\\",\[\{\\"1\\":\[\[0,0,\\"([^"\\]+)\\"/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      tabs.push({ gid: m[1], label: m[2] });
    }

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    res.json(tabs);
  } catch (err) {
    console.error('Sheet tabs fetch error:', err.message);
    res.status(502).json({ error: 'Failed to fetch sheet tabs' });
  }
}
