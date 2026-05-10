export default async function handler(req, res) {
  const { id, gid } = req.query;
  if (!id) return res.status(400).send('Sheet ID required');
  const url = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}/export?format=csv${gid ? `&gid=${encodeURIComponent(gid)}` : ''}`;
  try {
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) throw new Error(`Google returned ${response.status}`);
    const csv = await response.text();
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    res.send(csv);
  } catch (err) {
    console.error('Sheet fetch error:', err.message);
    res.status(502).send('Failed to fetch sheet');
  }
}
