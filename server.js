const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { exec, spawn } = require('child_process');
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

let isQueueLocked = false;
let isPaused = false;
let currentVolume = 100;

function sendMpvCommand(commandArray) {
  if (!fs.existsSync(MPV_SOCKET)) return;
  const client = net.connect(MPV_SOCKET, () => {
    client.write(JSON.stringify({ command: commandArray }) + '\n');
    client.end();
  });
  client.on('error', () => {});
}

function getMediaData(youtubeUrl) {
  return new Promise((resolve, reject) => {
    const command = `yt-dlp -f "best[ext=mp4]/best" --dump-json --no-playlist "${youtubeUrl}"`;

    exec(command, { maxBuffer: 1024 * 1024 * 15 }, async (error, stdout, stderr) => {
      if (error) return reject('No se pudo procesar el enlace de YouTube.');
      
      try {
        const data = JSON.parse(stdout);
        const duration = data.duration || 0;

        if (duration > MAX_DURATION_SECONDS) {
          return reject(`La canción excede el límite permitido de 8 minutos (${Math.round(duration / 60)} min).`);
        }

        const audioUrl = await getAudioOnlyUrl(youtubeUrl);

        resolve({
          id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
          url: youtubeUrl,
          title: data.title || 'Canción de Gym',
          artist: data.uploader || data.channel || 'Nealtican Gym',
          thumbnail: data.thumbnail || '',
          duration: duration,
          videoUrl: data.url,
          audioUrl: audioUrl
        });
      } catch (parseErr) {
        reject('Error al analizar la información del video.');
      }
    });
  });
}

function getAudioOnlyUrl(youtubeUrl) {
  return new Promise((resolve) => {
    exec(`yt-dlp -f bestaudio -g "${youtubeUrl}"`, (err, stdout) => {
      if (err) resolve(null);
      else resolve(stdout.trim().split('\n')[0]);
    });
  });
}

/**
 * Detiene de forma limpia el proceso mpv actual evitando bucles de eventos
 */
function stopCurrentAudio() {
  if (currentAudioProcess) {
    currentAudioProcess.removeAllListeners('close'); // Elimina el callback para evitar re-invocación
    currentAudioProcess.kill('SIGKILL');
    currentAudioProcess = null;
  }
}

function playServerAudio(audioUrl) {
  stopCurrentAudio();

  if (fs.existsSync(MPV_SOCKET)) {
    try { fs.unlinkSync(MPV_SOCKET); } catch(e){}
  }

  if (!audioUrl) return;

  console.log('[Audio Server] Reproduciendo audio...');
  
  currentAudioProcess = spawn('mpv', [
    '--no-video',
    `--input-ipc-server=${MPV_SOCKET}`,
    `--volume=${currentVolume}`,
    audioUrl
  ]);

  isPaused = false;
  io.emit('player-status-changed', { isPaused, volume: currentVolume });

  currentAudioProcess.on('close', () => {
    currentAudioProcess = null;
    playNextSong();
  });
}

async function playNextSong() {
  if (musicQueue.length === 0) {
    currentSong = null;
    stopCurrentAudio();
    
    // Notificar a las TVs y Admin que la reproducción ha finalizado por completo
    io.emit('song-changed', {
      title: 'Esperando canción...',
      artist: 'Nealtican Gym',
      thumbnail: '',
      videoUrl: null
    });
    io.emit('update-music-queue', musicQueue);
    return;
  }

  currentSong = musicQueue.shift();
  io.emit('update-music-queue', musicQueue);
  io.emit('song-changed', currentSong);
  playServerAudio(currentSong.audioUrl);
}

// Websockets
io.on('connection', (socket) => {
  const clientIp = socket.handshake.address;

  socket.emit('update-music-queue', musicQueue);
  socket.emit('queue-lock-changed', isQueueLocked);
  socket.emit('player-status-changed', { isPaused, volume: currentVolume });
  socket.emit('song-changed', currentSong || {
    title: 'Esperando canción...',
    artist: 'Nealtican Gym',
    thumbnail: '',
    videoUrl: null
  });

  socket.on('add-song', async (data) => {
    if (isQueueLocked) {
      return socket.emit('song-error', 'La cola está pausada por la administración.');
    }

    const userSongsInQueue = musicQueue.filter(song => song.clientIp === clientIp).length;
    if (userSongsInQueue >= MAX_SONGS_PER_IP) {
      return socket.emit('song-error', `Ya tienes ${MAX_SONGS_PER_IP} canciones en la fila.`);
    }

    try {
      const mediaData = await getMediaData(data.url);
      mediaData.clientIp = clientIp;

      if (!currentSong) {
        currentSong = mediaData;
        io.emit('song-changed', currentSong);
        playServerAudio(currentSong.audioUrl);
      } else {
        musicQueue.push(mediaData);
        io.emit('update-music-queue', musicQueue);
      }
      socket.emit('song-added-success', '¡Canción añadida!');
    } catch (err) {
      socket.emit('song-error', typeof err === 'string' ? err : 'Enlace no válido.');
    }
  });

  socket.on('admin-add-song', async (data) => {
    try {
      const mediaData = await getMediaData(data.url);
      mediaData.clientIp = 'ADMIN';

      if (!currentSong) {
        currentSong = mediaData;
        io.emit('song-changed', currentSong);
        playServerAudio(currentSong.audioUrl);
      } else {
        musicQueue.push(mediaData);
        io.emit('update-music-queue', musicQueue);
      }
    } catch (err) {
      socket.emit('song-error', 'Error al procesar la canción solicitada.');
    }
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
  console.log(`Servidor Nealtican Gym escuchando en http://localhost:${PORT}`);
});
