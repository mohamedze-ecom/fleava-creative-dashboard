require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
const PORT = process.env.PORT || 3000;
const TOKENS_PATH = path.join(__dirname, 'tokens.json');

// Load saved tokens
let accounts = {};
if (fs.existsSync(TOKENS_PATH)) {
  try {
    accounts = JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8'));
  } catch (e) {
    accounts = {};
  }
}

function saveTokens() {
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(accounts, null, 2));
}

function createOAuth2Client(req) {
  const baseUrl = req
    ? `${req.protocol}://${req.get('host')}`
    : `http://localhost:${PORT}`;
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${baseUrl}/auth/callback`
  );
}

function getAuthClient(req, email) {
  const data = accounts[email];
  if (!data) return null;
  const oauth2Client = createOAuth2Client(req);
  oauth2Client.setCredentials(data.tokens);
  oauth2Client.on('tokens', (newTokens) => {
    if (newTokens.refresh_token) {
      accounts[email].tokens.refresh_token = newTokens.refresh_token;
    }
    accounts[email].tokens.access_token = newTokens.access_token;
    accounts[email].tokens.expiry_date = newTokens.expiry_date;
    saveTokens();
  });
  return oauth2Client;
}

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Get connected accounts
app.get('/api/accounts', (req, res) => {
  const accountList = Object.entries(accounts).map(([email, data]) => ({
    email,
    connected: true,
  }));
  res.json(accountList);
});

// Start OAuth flow
app.get('/auth/connect', (req, res) => {
  const oauth2Client = createOAuth2Client(req);
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/userinfo.email',
    ],
  });
  res.redirect(authUrl);
});

// OAuth callback
app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) {
    return res.status(400).send('No authorization code provided');
  }

  try {
    const oauth2Client = createOAuth2Client(req);
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const userInfo = await oauth2.userinfo.get();
    const email = userInfo.data.email;

    accounts[email] = {
      tokens,
      connectedAt: new Date().toISOString(),
    };
    saveTokens();

    res.send(`
      <html>
        <body style="font-family: 'Inter', system-ui, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #121218;">
          <div style="text-align: center; padding: 48px; background: #1a1a22; border: 1px solid rgba(255,255,255,0.08); border-radius: 16px;">
            <div style="width: 48px; height: 48px; background: rgba(74,222,128,0.12); border-radius: 12px; display: flex; align-items: center; justify-content: center; margin: 0 auto 20px; font-size: 22px; color: #4ade80;">&#10003;</div>
            <h2 style="color: #ececef; font-size: 18px; font-weight: 600; margin: 0 0 8px;">Connected</h2>
            <p style="color: #5a5a66; font-size: 14px; margin: 0;">${email} has been linked.</p>
            <script>setTimeout(() => window.close(), 1500);</script>
          </div>
        </body>
      </html>
    `);
  } catch (error) {
    console.error('Auth error:', error.message);
    res.status(500).send('Authentication failed: ' + error.message);
  }
});

// Disconnect an account
app.delete('/api/accounts/:email', (req, res) => {
  const email = decodeURIComponent(req.params.email);
  if (accounts[email]) {
    delete accounts[email];
    saveTokens();
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Account not found' });
  }
});

// RSVP to an event
app.post('/api/events/:eventId/rsvp', async (req, res) => {
  const { eventId } = req.params;
  const { account, status } = req.body; // status: accepted, declined, tentative

  if (!account || !status) {
    return res.status(400).json({ error: 'account and status required' });
  }

  try {
    const auth = getAuthClient(req, account);
    if (!auth) return res.status(404).json({ error: 'Account not found' });

    const calendar = google.calendar({ version: 'v3', auth });

    // Get the event first
    const event = await calendar.events.get({
      calendarId: 'primary',
      eventId,
    });

    // Update the self attendee's status
    const attendees = event.data.attendees || [];
    const selfAttendee = attendees.find(a => a.self);
    if (selfAttendee) {
      selfAttendee.responseStatus = status;
    } else {
      attendees.push({
        email: account,
        responseStatus: status,
        self: true,
      });
    }

    await calendar.events.patch({
      calendarId: 'primary',
      eventId,
      requestBody: { attendees },
    });

    res.json({ success: true });
  } catch (error) {
    console.error('RSVP error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Delete/cancel an event
app.delete('/api/events/:eventId', async (req, res) => {
  const { account } = req.body;
  if (!account) {
    return res.status(400).json({ error: 'account required' });
  }

  try {
    const auth = getAuthClient(req, account);
    if (!auth) return res.status(404).json({ error: 'Account not found' });

    const calendar = google.calendar({ version: 'v3', auth });
    await calendar.events.delete({
      calendarId: 'primary',
      eventId: req.params.eventId,
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Delete error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Fetch events from all connected accounts
app.get('/api/events', async (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) {
    return res.status(400).json({ error: 'start and end query params required' });
  }

  const colors = ['#6366f1', '#f59e0b', '#10b981', '#ec4899', '#ef4444', '#06b6d4'];
  const allEvents = [];
  let colorIndex = 0;

  for (const [email, data] of Object.entries(accounts)) {
    try {
      const auth = getAuthClient(req, email);

      const calendar = google.calendar({ version: 'v3', auth });
      const response = await calendar.events.list({
        calendarId: 'primary',
        timeMin: start,
        timeMax: end,
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 250,
        fields: 'items(id,summary,start,end,description,location,htmlLink,hangoutLink,conferenceData,attendees,organizer,status,creator)',
      });

      const color = colors[colorIndex % colors.length];
      const events = (response.data.items || []).map((event) => {
        let meetingLink = event.hangoutLink || '';
        let meetingType = '';
        if (event.conferenceData) {
          const ep = event.conferenceData.entryPoints;
          if (ep && ep.length > 0) {
            const videoEntry = ep.find(e => e.entryPointType === 'video');
            if (videoEntry) {
              meetingLink = videoEntry.uri;
              meetingType = videoEntry.label || '';
            }
          }
          if (event.conferenceData.conferenceSolution) {
            meetingType = event.conferenceData.conferenceSolution.name || meetingType;
          }
        }

        const attendees = (event.attendees || []).map(a => ({
          email: a.email,
          name: a.displayName || a.email,
          status: a.responseStatus || 'needsAction',
          self: a.self || false,
          organizer: a.organizer || false,
        }));

        // Find self RSVP status
        const selfAttendee = attendees.find(a => a.self);
        const myStatus = selfAttendee ? selfAttendee.status : 'owner';

        return {
          id: event.id,
          title: event.summary || '(No title)',
          start: event.start.dateTime || event.start.date,
          end: event.end.dateTime || event.end.date,
          allDay: !event.start.dateTime,
          backgroundColor: color,
          borderColor: color,
          extendedProps: {
            account: email,
            description: event.description || '',
            location: event.location || '',
            htmlLink: event.htmlLink,
            meetingLink,
            meetingType,
            attendees,
            organizer: event.organizer ? (event.organizer.displayName || event.organizer.email || '') : '',
            status: event.status || '',
            myStatus,
          },
        };
      });

      allEvents.push(...events);
    } catch (error) {
      console.error(`Error fetching events for ${email}:`, error.message);
      if (error.code === 401 || error.message.includes('invalid_grant')) {
        delete accounts[email];
        saveTokens();
      }
    }

    colorIndex++;
  }

  res.json(allEvents);
});

// Proxy endpoint for Google Sheets CSV export (avoids CORS)
app.get('/api/sheet-csv', async (req, res) => {
  const { id, gid } = req.query;
  if (!id) return res.status(400).send('Sheet ID required');
  const url = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}/export?format=csv${gid ? `&gid=${encodeURIComponent(gid)}` : ''}`;
  try {
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) throw new Error(`Google returned ${response.status}`);
    const csv = await response.text();
    res.setHeader('Content-Type', 'text/csv');
    res.send(csv);
  } catch (err) {
    console.error('Sheet fetch error:', err.message);
    res.status(502).send('Failed to fetch sheet');
  }
});

app.listen(PORT, () => {
  console.log(`\n  Unified Calendar running at http://localhost:${PORT}\n`);
});
