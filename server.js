const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { spawn, execFile } = require('child_process');
const path = require('path');
const net = require('net');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const ADMIN_PIN = "1234";
const MAX_SONGS_PER_IP = 2;
const MAX_DURATION_SECONDS = 480;
const MPV_SOCKET = '/tmp/mpvsocket';

// Archivos estáticos
app.use('/styles', express.static(path.join(__dirname, 'styles')));
app.use('/mobile', express.static(path.join(__dirname, 'pages/mobile')));
app.use('/tv', express.static(path.join(__dirname, 'pages/tv')));
app.use('/admin', express.static(path.join(__dirname, 'pages/admin')));

// Rutas
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'pages/mobile/index.html')));
app.get('/tv1', (req, res) => res.sendFile(path.join(__dirname, 'pages/tv/index.html')));
app.get('/tv2', (req, res) => res.sendFile(path.join(__dirname, 'pages/tv/index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'pages/admin/index.html')));

let musicQueue = [];
let currentSong = null;
let currentAudioProcess = null;

// Temporizadores de control
let syncFallbackTimer = null;
let songEndTimer = null; // 🎯 Temporizador Maestro que invoca "Saltar Canción"

// Cola en serie para evitar que se encimen peticiones al añadir
let isProcessingAdd = false;
const pendingAddRequests = [];

let isQueueLocked = false;
let isPaused = false;
let currentVolume = 100;

function getCleanIp(address) {
  if (!address) return '127.0.0.1';
  let ip = address.replace(/^.*:/, '');
  if (ip === '1' || ip === '' || ip === 'localhost') return '127.0.0.1';
  return ip;
}

function cleanYoutubeUrl(rawUrl) {
  if (!rawUrl) return null;
  const regExp = /^.*(?:youtu\.be\/|v\/|u\/\w\/|embed\/|shorts\/|watch\?v=|\&v=)([^#\&\?]*).*/;
  const match = rawUrl.match(regExp);

  if (match && match[1] && match[1].length === 11) {
    return `https://www.youtube.com/watch?v=${match[1]}`;
  }
  return null;
}

function sendMpvCommand(commandArray) {
  if (!fs.existsSync(MPV_SOCKET)) return;
  const client = net.connect(MPV_SOCKET, () => {
    client.write(JSON.stringify({ command: commandArray }) + '\n');
    client.end();
  });
  client.on('error', () => {});
}

/**
 * Obtiene metadata y duración de YouTube
 */
function getMetadata(youtubeUrl) {
  return new Promise((resolve, reject) => {
    const args = ['--force-ipv4', '--no-warnings', '--dump-json', '--no-playlist', youtubeUrl];

    execFile('yt-dlp', args, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout) => {
      if (error || !stdout) return reject('No se pudo obtener información del video.');

      try {
        const jsonStart = stdout.indexOf('{');
        const jsonEnd = stdout.lastIndexOf('}');
        if (jsonStart === -1 || jsonEnd === -1) return reject('Respuesta no válida.');

        const data = JSON.parse(stdout.substring(jsonStart, jsonEnd + 1));
        const duration = data.duration || 0;

        if (duration > MAX_DURATION_SECONDS) {
          return reject(`La canción excede el límite permitido de 8 minutos (${Math.round(duration / 60)} min).`);
        }

        resolve({
          id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
          url: youtubeUrl,
          title: data.title || 'Canción de Gym',
          artist: data.uploader || data.channel || 'Nealtican Gym',
          thumbnail: data.thumbnail || '',
          duration: duration
        });
      } catch (err) {
        reject('Error al analizar la información de YouTube.');
      }
    });
  });
}

/**
 * Extrae enlace directo para el reproductor de video de la TV
 */
function getFreshVideoUrl(youtubeUrl) {
  return new Promise((resolve) => {
    const args = [
      '--force-ipv4',
      '--no-warnings',
      '-f', 'bestvideo[height<=1080][ext=mp4]/bestvideo[height<=1080]/best',
      '-g',
      youtubeUrl
    ];

    execFile('yt-dlp', args, (err, stdout) => {
      if (err || !stdout) resolve(null);
      else resolve(stdout.trim().split('\n')[0]);
    });
  });
}

/**
 * Detiene audio actual y limpia TODOS los temporizadores
 */
function stopCurrentAudio() {
  if (syncFallbackTimer) {
    clearTimeout(syncFallbackTimer);
    syncFallbackTimer = null;
  }
  if (songEndTimer) {
    clearTimeout(songEndTimer);
    songEndTimer = null;
  }
  if (currentAudioProcess) {
    currentAudioProcess.removeAllListeners('close');
    currentAudioProcess.kill('SIGKILL');
    currentAudioProcess = null;
  }
}

/**
 * Inicia la reproducción del audio en las bocinas vía MPV
 */
function playServerAudio(youtubeUrl) {
  if (fs.existsSync(MPV_SOCKET)) {
    try { fs.unlinkSync(MPV_SOCKET); } catch (e) {}
  }

  if (!youtubeUrl) return;

  console.log('[Audio Server] Reproduciendo en bocinas...');
  const startTime = Date.now();

  currentAudioProcess = spawn('mpv', [
    '--no-video',
    '--ytdl-format=bestaudio/best',
    `--input-ipc-server=${MPV_SOCKET}`,
    `--volume=${currentVolume}`,
    '--cache=yes',
    '--demuxer-max-bytes=50M',
    '--demuxer-readahead-secs=60',
    youtubeUrl
  ]);

  isPaused = false;
  io.emit('player-status-changed', { isPaused, volume: currentVolume });

  currentAudioProcess.on('close', (code) => {
    currentAudioProcess = null;
    const durationPlayed = (Date.now() - startTime) / 1000;
    console.log(`[Audio Server] MPV cerró tras ${durationPlayed.toFixed(1)}s.`);

    // Si MPV se cierra tras haber reproducido más de 5 segundos,
    // asumimos que terminó o YouTube cortó el final y avanzamos la cola inmediatamente.
    if (durationPlayed > 5) {
      playNextSong();
    }
  });
}

/**
 * Inicia la canción actual y programa el temporizador automático de cambio
 */
async function startSyncedPlayback(songData) {
  stopCurrentAudio();

  console.log(`[Servidor] Cargando: "${songData.title}" (${songData.duration}s)`);
  
  const freshVideoUrl = await getFreshVideoUrl(songData.url);
  currentSong = { ...songData, videoUrl: freshVideoUrl };

  io.emit('song-changed', currentSong);

  // 1. Respando de sincronización por si la TV no responde
  syncFallbackTimer = setTimeout(() => {
    if (currentSong && currentSong.id === songData.id && !currentAudioProcess) {
      console.log('[Sincronización Fallback] TV no notificó inicio. Arrancando audio...');
      playServerAudio(currentSong.url);
    }
  }, 3500);

  // 2. 🎯 TEMPORIZADOR MAESTRO (Acción del botón Saltar Canción automatizada)
  // Duración real + 2 segundos de margen
  const autoSkipDelayMs = ((songData.duration > 0 ? songData.duration : 240) + 2) * 1000;
  
  songEndTimer = setTimeout(() => {
    console.log(`[Timer Servidor] Tiempo límite alcanzado (${songData.duration}s). Ejecutando cambio automático...`);
    playNextSong();
  }, autoSkipDelayMs);
}

/**
 * Pasa a la siguiente canción en la cola (Función ejecutada por el Botón "Saltar Canción" y el Timer)
 */
async function playNextSong() {
  stopCurrentAudio();

  if (musicQueue.length === 0) {
    currentSong = null;

    io.emit('song-changed', {
      title: 'Esperando canción...',
      artist: 'Nealtican Gym',
      thumbnail: '',
      videoUrl: null
    });
    io.emit('update-music-queue', musicQueue);
    return;
  }

  const nextSong = musicQueue.shift();
  io.emit('update-music-queue', musicQueue);
  await startSyncedPlayback(nextSong);
}

/**
 * Procesador en serie para peticiones concurrentes
 */
async function processAddQueue() {
  if (isProcessingAdd || pendingAddRequests.length === 0) return;

  isProcessingAdd = true;
  const { socket, url, clientIp, isAdmin } = pendingAddRequests.shift();

  const cleanedUrl = cleanYoutubeUrl(url);
  if (!cleanedUrl) {
    socket.emit('song-error', 'El enlace ingresado no es un video válido de YouTube.');
    isProcessingAdd = false;
    processAddQueue();
    return;
  }

  if (!isAdmin && isQueueLocked && clientIp !== '127.0.0.1') {
    socket.emit('song-error', 'La cola está pausada por la administración.');
    isProcessingAdd = false;
    processAddQueue();
    return;
  }

  const userSongsInQueue = musicQueue.filter(song => song.clientIp === clientIp).length;
  if (!isAdmin && clientIp !== '127.0.0.1' && userSongsInQueue >= MAX_SONGS_PER_IP) {
    socket.emit('song-error', `Ya tienes ${MAX_SONGS_PER_IP} canciones en la fila.`);
    isProcessingAdd = false;
    processAddQueue();
    return;
  }

  try {
    const mediaData = await getMetadata(cleanedUrl);
    mediaData.clientIp = isAdmin ? 'ADMIN' : clientIp;

    if (!currentSong) {
      await startSyncedPlayback(mediaData);
    } else {
      musicQueue.push(mediaData);
      io.emit('update-music-queue', musicQueue);
    }
    socket.emit('song-added-success', '¡Canción añadida!');
  } catch (err) {
    socket.emit('song-error', typeof err === 'string' ? err : 'Enlace no válido.');
  } finally {
    isProcessingAdd = false;
    processAddQueue();
  }
}

// Websockets
io.on('connection', (socket) => {
  const rawIp = socket.handshake.address;
  const clientIp = getCleanIp(rawIp);

  socket.emit('update-music-queue', musicQueue);
  socket.emit('queue-lock-changed', isQueueLocked);
  socket.emit('player-status-changed', { isPaused, volume: currentVolume });
  socket.emit('song-changed', currentSong || {
    title: 'Esperando canción...',
    artist: 'Nealtican Gym',
    thumbnail: '',
    videoUrl: null
  });

  socket.on('tv-video-started', () => {
    if (syncFallbackTimer) {
      clearTimeout(syncFallbackTimer);
      syncFallbackTimer = null;
    }
    if (currentSong && !currentAudioProcess) {
      console.log('[Sincronización] TV lista. Arrancando bocinas...');
      playServerAudio(currentSong.url);
    }
  });

  socket.on('add-song', (data) => {
    pendingAddRequests.push({ socket, url: data.url, clientIp, isAdmin: false });
    processAddQueue();
  });

  socket.on('admin-add-song', (data) => {
    pendingAddRequests.push({ socket, url: data.url, clientIp, isAdmin: true });
    processAddQueue();
  });

  socket.on('admin-login', (pin) => {
    if (pin === ADMIN_PIN) socket.emit('admin-auth-success');
    else socket.emit('admin-auth-fail', 'PIN Incorrecto');
  });

  socket.on('admin-toggle-pause', () => {
    isPaused = !isPaused;
    sendMpvCommand(['set_property', 'pause', isPaused]);
    io.emit('player-status-changed', { isPaused, volume: currentVolume });
  });

  socket.on('admin-set-volume', (vol) => {
    currentVolume = parseInt(vol);
    sendMpvCommand(['set_property', 'volume', currentVolume]);
    io.emit('player-status-changed', { isPaused, volume: currentVolume });
  });

  // Botón "Saltar Canción" invoca la misma función
  socket.on('admin-skip-song', () => {
    console.log('[Admin] Salto manual solicitado.');
    playNextSong();
  });

  socket.on('admin-remove-song', (songId) => {
    musicQueue = musicQueue.filter(song => song.id !== songId);
    io.emit('update-music-queue', musicQueue);
  });

  socket.on('admin-clear-queue', () => {
    musicQueue = [];
    io.emit('update-music-queue', musicQueue);
  });

  socket.on('admin-toggle-lock', () => {
    isQueueLocked = !isQueueLocked;
    io.emit('queue-lock-changed', isQueueLocked);
  });
});

server.listen(PORT, () => {
  console.log(`Servidor Nealtican Gym activo en http://localhost:${PORT}`);
}); 
