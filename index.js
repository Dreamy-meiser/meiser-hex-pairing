const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
require('dotenv').config();
const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, Browsers, DisconnectReason } = require('baileys');
const { v4: uuidv4 } = require('uuid');
const P = require('pino');
const qrcode = require('qrcode');

// 🗄️ Supabase setup
const supabase = createClient(
  'https://uxflsgfieysskazxyvpb.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV4ZmxzZ2ZpZXlzc2thenh5dnBiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTEwNTY0NjAsImV4cCI6MjA2NjYzMjQ2MH0.MkKpgXEzj7Y3sedmUaUSGK7Db5io-V0W3fEt04glZec'
);

const app = express();
const port = process.env.PORT || 5001;
app.use(express.json());
app.use(express.static('public'));

const sessions = new Map(); // sessionId => { sock, connected, userJid, qr }

// 🧩 Generate a unique session ID
function generateSessionId() {
  return 'MEISER-HEX-' +
    uuidv4().replace(/-/g, '') +
    uuidv4().replace(/-/g, '') +
    uuidv4().replace(/-/g, '');
}

// ☁️ Upload auth folder as .zip to Supabase
async function uploadAuthToSupabase(sessionId) {
  const zip = new AdmZip();
  const authPath = path.join(__dirname, 'auth', sessionId);

  if (!fs.existsSync(authPath)) {
    console.error('❌ Auth folder not found:', authPath);
    return;
  }

  zip.addLocalFolder(authPath);
  const zipBuffer = zip.toBuffer();

  const { data, error } = await supabase.storage
    .from('meiser-hex-sessions')
    .upload(`${sessionId}.zip`, zipBuffer, {
      contentType: 'application/zip',
      upsert: true
    });

  if (error) {
    console.error('❌ Failed to upload to Supabase:', error.message);
  } else {
    console.log('✅ Auth session uploaded to Supabase:', data.path);
  }
}

// 🆕 Create new session
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

// 📸 Get QR code
app.get('/api/qr/:sessionId', async (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (!session.qr) return res.status(204).send();
  res.json({ qr: session.qr });
});

// ⚙️ Start WhatsApp connection
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

    // 🧾 QR code generation
    if (qr) {
      try {
        const qrDataUrl = await qrcode.toDataURL(qr);
        session.qr = qrDataUrl;
        sessions.set(sessionId, session);
      } catch (err) {
        console.error('❌ Error generating QR:', err);
      }
    }

    // ✅ Connection open
    if (connection === 'open') {
      const userJid = sock.user.id;
      session.connected = true;
      session.userJid = userJid;
      session.qr = null;
      sessions.set(sessionId, session);

      console.log(`✅ Connected: ${sessionId} as ${userJid}`);

      // Wait a moment before sending messages
 // Wait a moment before sending messages
setTimeout(async () => {
  try {
    // Normalize JID to ensure message goes to correct user
    const cleanJid = userJid.includes(':')
      ? userJid.split(':')[0] + '@s.whatsapp.net'
      : userJid;

    // 1️⃣ Send welcome message
    const welcomeMessage = `╭─────⊷ *MEISER-HEX LINKED* ⊶─────╮
✨ Your connection to the *MEISER-HEX* engine has been established!
🔗 This session grants you full interaction rights with the bot system.
🚀 Keep your Session ID secure for future deployments.
🌌 If hosting on Heroku or similar panels, use this Session ID as a launch token.
╰────⊷ Welcome to the command core.`;

    await sock.sendMessage(cleanJid, { text: welcomeMessage });

    // 2️⃣ Send session ID separately (tap-to-copy style)
    const sessionMessage = ` \n\`\`\`${sessionId}\`\`\`\n\n`;

    await sock.sendMessage(cleanJid, { text: sessionMessage });

    console.log(`✅ Sent welcome message + session ID separately to ${cleanJid}`);
  } catch (e) {
    console.error('❌ Failed to send session ID to user:', e);
  }
}, 2000);

      // Upload auth after 2s
      setTimeout(async () => {
        await uploadAuthToSupabase(sessionId);
      }, 2000);

      // Safe disconnect after 2 minutes
      setTimeout(() => {
        console.log(`🔒 Disconnecting ${sessionId} to avoid dual connection...`);
        if (sock.ws) {
          sock.ws.close();
          sock.ev.removeAllListeners();
          console.log(`📴 WebSocket closed and events removed for ${sessionId} (session still valid)`);
        }
      }, 120000);
    }

    // 🔌 Disconnection handling
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log(`🔌 Disconnected: ${sessionId}. Reconnect? ${shouldReconnect}`);
      if (shouldReconnect) startWhatsApp(sessionId);
    }
  });

  sessions.get(sessionId).sock = sock;
}

// 🔁 API endpoint to start session
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

// 🚀 Start server
app.listen(port, () => {
  console.log(`🛰️ MEISER-HEX pairing server running on port ${port}`);
});
