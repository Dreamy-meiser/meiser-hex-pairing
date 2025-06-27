require('dotenv').config();
const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, Browsers, DisconnectReason } = require('baileys');
const { v4: uuidv4 } = require('uuid');
const P = require('pino');
const qrcode = require('qrcode');

const app = express();
const port = process.env.PORT || 5001;

app.use(express.json());
app.use(express.static('public'));

const sessions = new Map(); // sessionId => { sock, connected, userJid, qr }

function generateSessionId() {
  return 'MEISER-HEX-' +
    uuidv4().replace(/-/g, '') +
    uuidv4().replace(/-/g, '') +
    uuidv4().replace(/-/g, '');
}

// Create new session
app.post('/api/create-session', (req, res) => {
  const sessionId = generateSessionId();
  sessions.set(sessionId, {
    sock: null,
    connected: false,
    userJid: null,
    qr: null,
    createdAt: new Date().toISOString()
  });
  res.json({
    sessionId,
    message: '🔗 Session created successfully. Scan QR to connect.'
  });
});

// Get QR code
app.get('/api/qr/:sessionId', async (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  if (!session.qr) return res.status(204).send(); // No QR yet
  res.json({ qr: session.qr });
});

// Start WhatsApp connection
async function startWhatsApp(sessionId) {
  const { state, saveCreds } = await useMultiFileAuthState(`./auth/${sessionId}`);

  const sock = makeWASocket({
    auth: state,
    logger: P({ level: 'silent' }),
    browser: Browsers.macOS('MeiserBot'),
    printQRInTerminal: true
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const session = sessions.get(sessionId);
    if (!session) return;

    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        const qrDataUrl = await qrcode.toDataURL(qr);
        session.qr = qrDataUrl;
        sessions.set(sessionId, session);
      } catch (err) {
        console.error('❌ Error generating QR:', err);
      }
    }

    if (connection === 'open') {
      const userJid = sock.user.id;
      session.connected = true;
      session.userJid = userJid;
      session.qr = null;
      sessions.set(sessionId, session);

      console.log(`✅ Connected: ${sessionId} as ${userJid}`);

      // Send messages to user in two parts
      try {
        await sock.sendMessage(userJid, {
          text: `╭─────⊷ *MEISER-HEX LINKED* ⊶─────╮
✨ Your connection to the *MEISER-HEX* engine has been established!
🔗 This session grants you full interaction rights with the bot system.
🚀 Keep your Session ID secure for future deployments.
🌌 If hosting on Heroku or similar panels, use this Session ID as a launch token.
╰────⊷ Welcome to the command core.`
        });
        await sock.sendMessage(userJid, {
          text: sessionId
        });
      } catch (e) {
        console.error('❌ Failed to send session ID to user:', e);
      }
    }

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log(`🔌 Disconnected: ${sessionId}. Reconnect? ${shouldReconnect}`);
      if (shouldReconnect) startWhatsApp(sessionId);
    }
  });

  sessions.get(sessionId).sock = sock;
}

// Endpoint to start WhatsApp socket for session
app.post('/api/start/:sessionId', async (req, res) => {
  const sessionId = req.params.sessionId;
  if (!sessions.has(sessionId)) {
    return res.status(404).json({ error: 'Session not found' });
  }

  try {
    await startWhatsApp(sessionId);
    res.json({ message: `🔌 Started WhatsApp for session ${sessionId}` });
  } catch (err) {
    console.error('❌ Start Error:', err);
    res.status(500).json({ error: 'Failed to start WhatsApp' });
  }
});

app.listen(port, () => {
  console.log(`🛰️ MEISER-HEX pairing server running on port ${port}`);
});
