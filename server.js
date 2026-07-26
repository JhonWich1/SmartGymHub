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

// Ruta absoluta a tus videos de rutinas en Linux
const ROUTINES_DIR = '/home/jhonwich/Videos/nealticanGym/routines';

// Servir archivos estáticos
app.use('/styles', express.static(path.join(__dirname, 'styles')));
app.use('/mobile', express.static(path.join(__dirname, 'pages/mobile')));
app.use('/tv', express.static(path.join(__dirname, 'pages/tv')));
app.use('/admin', express.static(path.join(__dirname, 'pages/admin')));

// Servir videos de ejercicios directamente desde el disco duro
app.use('/routines-media', express.static(ROUTINES_DIR));

// Rutas de navegación
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'pages/mobile/index.html')));
app.get('/tv1', (req, res) => res.sendFile(path.join(__dirname, 'pages/tv/index.html')));
app.get('/tv2', (req, res) => res.sendFile(path.join(__dirname, 'pages/tv/index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'pages/admin/index.html')));

let musicQueue = [];
let currentSong = null;
let currentAudioProcess = null;
let songStartedAt = null;

// Estados y Colas independientes por Pantalla (TV1 y TV2)
const tvState = {
  tv1: { isBusy: false, queue: [] },
  tv2: { isBusy: false, queue: [] }
};

let syncFallbackTimer = null;
let songEndTimer = null;
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

function stopCurrentAudio() {
  if (syncFallbackTimer) { clearTimeout(syncFallbackTimer); syncFallbackTimer = null; }
  if (songEndTimer) { clearTimeout(songEndTimer); songEndTimer = null; }
  if (currentAudioProcess) {
    currentAudioProcess.removeAllListeners('close');
    currentAudioProcess.kill('SIGKILL');
    currentAudioProcess = null;
  }
}

function playServerAudio(youtubeUrl) {
  if (fs.existsSync(MPV_SOCKET)) {
    try { fs.unlinkSync(MPV_SOCKET); } catch (e) {}
  }

  if (!youtubeUrl) return;

  console.log('[Audio Server] Reproduciendo en bocinas...');
  songStartedAt = Date.now();

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
    if (songStartedAt && (Date.now() - songStartedAt) > 5000) {
      playNextSong();
    }
  });
}

async function startSyncedPlayback(songData) {
  stopCurrentAudio();
  console.log(`[Servidor] Cargando: "${songData.title}" (${songData.duration}s)`);
  
  const freshVideoUrl = await getFreshVideoUrl(songData.url);
  currentSong = { ...songData, videoUrl: freshVideoUrl };

  io.emit('song-changed', currentSong);

  syncFallbackTimer = setTimeout(() => {
    if (currentSong && currentSong.id === songData.id && !currentAudioProcess) {
      playServerAudio(currentSong.url);
    }
  }, 3500);

  const autoSkipDelayMs = ((songData.duration > 0 ? songData.duration : 240) + 2) * 1000;
  songEndTimer = setTimeout(() => {
    playNextSong();
  }, autoSkipDelayMs);
}

async function playNextSong() {
  stopCurrentAudio();
  songStartedAt = null;

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

// =======================================================
// LÓGICA DE RUTINAS (TOTALMENTE INDEPENDIENTE DE LA MÚSICA)
// =======================================================
function processRoutineQueue(tvId) {
  const state = tvState[tvId];
  if (!state) return;

  if (state.queue.length === 0) {
    state.isBusy = false;
    return;
  }

  state.isBusy = true;
  const routine = state.queue.shift();

  // Enviar comando a la TV correspondiente (SIN pausar mpv ni modificar música)
  io.emit('play-routine-tv', {
    tvId: tvId,
    routine: routine
  });
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
    if (syncFallbackTimer) { clearTimeout(syncFallbackTimer); syncFallbackTimer = null; }
    if (currentSong && !currentAudioProcess) {
      playServerAudio(currentSong.url);
    }
  });

  // SOLICITUD DE TRANSMISIÓN DE RUTINA DESDE EL MÓVIL
  socket.on('request-routine-transmit', (data) => {
    const { tvId, routine } = data;
    if (!tvState[tvId]) return;

    if (tvState[tvId].isBusy) {
      tvState[tvId].queue.push(routine);
      socket.emit('routine-status', {
        status: 'queued',
        message: `Petición agregada a la cola de ${tvId.toUpperCase()}. Posición: ${tvState[tvId].queue.length}`
      });
    } else {
      tvState[tvId].queue.push(routine);
      socket.emit('routine-status', {
        status: 'playing',
        message: `Transmitiendo a ${tvId.toUpperCase()}...`
      });
      processRoutineQueue(tvId);
    }
  });

  // NOTIFICACIÓN DE TV CUANDO TERMINA O CANCELA EL VIDEO DEL EJERCICIO
  socket.on('routine-finished', (tvId) => {
    console.log(`[Rutina] TV ${tvId} finalizó un ejercicio.`);
    const state = tvState[tvId];
    if (state) {
      state.isBusy = false;
      processRoutineQueue(tvId);
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

  socket.on('admin-skip-song', () => {
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
