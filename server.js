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
const ADMIN_PIN = "1970"; // 🔑
const MAX_SONGS_PER_IP = 2; // Máximo de canciones por usuario en la cola
const MAX_DURATION_SECONDS = 480; // 8 minutos máximo por canción
const MPV_SOCKET = '/tmp/mpvsocket';

// Rutas estáticas
app.use('/styles', express.static(path.join(__dirname, 'styles')));
app.use('/mobile', express.static(path.join(__dirname, 'pages/mobile')));
app.use('/tv', express.static(path.join(__dirname, 'pages/tv')));
app.use('/admin', express.static(path.join(__dirname, 'pages/admin')));

// Rutas de páginas
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'pages/mobile/index.html')));
app.get('/tv1', (req, res) => res.sendFile(path.join(__dirname, 'pages/tv/index.html')));
app.get('/tv2', (req, res) => res.sendFile(path.join(__dirname, 'pages/tv/index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'pages/admin/index.html')));

let musicQueue = [];
let currentSong = null;
let currentAudioProcess = null;

// Estado del Servidor / Admin
let isQueueLocked = false;
let isPaused = false;
let currentVolume = 100;

/**
 * Envía comandos IPC directamente a MPV (pausa, volumen, etc.)
 */
function sendMpvCommand(commandArray) {
  if (!fs.existsSync(MPV_SOCKET)) return;
  const client = net.connect(MPV_SOCKET, () => {
    client.write(JSON.stringify({ command: commandArray }) + '\n');
    client.end();
  });
  client.on('error', () => {}); // Silenciar si no hay proceso activo
}

/**
 * Extrae la metadata y valida las restricciones anti-spam
 */
function getMediaData(youtubeUrl) {
  return new Promise((resolve, reject) => {
    const command = `yt-dlp -f "best[ext=mp4]/best" --dump-json --no-playlist "${youtubeUrl}"`;

    exec(command, { maxBuffer: 1024 * 1024 * 15 }, async (error, stdout, stderr) => {
      if (error) return reject('No se pudo procesar el enlace de YouTube.');
      
      try {
        const data = JSON.parse(stdout);
        const duration = data.duration || 0;

        // Validar duración máxima ( Anti-Trolls )
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

function playServerAudio(audioUrl) {
  if (currentAudioProcess) {
    currentAudioProcess.kill();
    currentAudioProcess = null;
  }

  // Eliminar socket anterior si existe
  if (fs.existsSync(MPV_SOCKET)) {
    try { fs.unlinkSync(MPV_SOCKET); } catch(e){}
  }

  if (!audioUrl) return;

  console.log('[Audio Server] Reproduciendo en la bocina...');
  
  currentAudioProcess = spawn('mpv', [
    '--no-video',
    `--input-ipc-server=${MPV_SOCKET}`,
    `--volume=${currentVolume}`,
    audioUrl
  ]);

  isPaused = false;
  io.emit('player-status-changed', { isPaused, volume: currentVolume });

  currentAudioProcess.on('close', (code) => {
    currentAudioProcess = null;
    playNextSong();
  });
}

async function playNextSong() {
  if (musicQueue.length === 0) {
    currentSong = null;
    if (currentAudioProcess) {
      currentAudioProcess.kill();
      currentAudioProcess = null;
    }
    io.emit('song-changed', {
      title: 'Esperando canción...',
      artist: 'Nealtican Gym',
      thumbnail: '',
      videoUrl: null
    });
    return;
  }

  currentSong = musicQueue.shift();
  io.emit('update-music-queue', musicQueue);
  io.emit('song-changed', currentSong);
  playServerAudio(currentSong.audioUrl);
}

// Control de WebSockets
io.on('connection', (socket) => {
  const clientIp = socket.handshake.address;

  // Estado inicial
  socket.emit('update-music-queue', musicQueue);
  socket.emit('queue-lock-changed', isQueueLocked);
  socket.emit('player-status-changed', { isPaused, volume: currentVolume });
  socket.emit('song-changed', currentSong || {
    title: 'Esperando canción...',
    artist: 'Nealtican Gym',
    thumbnail: '',
    videoUrl: null
  });

  // --- ACCIONES DE USUARIOS MÓVILES ---
  socket.on('add-song', async (data) => {
    // 1. Validar bloqueo de cola
    if (isQueueLocked) {
      return socket.emit('song-error', 'La cola de canciones está pausada por la administración.');
    }

    // 2. Validar límite por IP
    const userSongsInQueue = musicQueue.filter(song => song.clientIp === clientIp).length;
    if (userSongsInQueue >= MAX_SONGS_PER_IP) {
      return socket.emit('song-error', `Ya tienes ${MAX_SONGS_PER_IP} canciones en la fila. Espera a que se reproduzcan.`);
    }

    try {
      const mediaData = await getMediaData(data.url);
      mediaData.clientIp = clientIp; // Registrar IP del creador

      if (!currentSong) {
        currentSong = mediaData;
        io.emit('song-changed', currentSong);
        playServerAudio(currentSong.audioUrl);
      } else {
        musicQueue.push(mediaData);
        io.emit('update-music-queue', musicQueue);
      }
      socket.emit('song-added-success', '¡Canción añadida con éxito!');
    } catch (err) {
      socket.emit('song-error', typeof err === 'string' ? err : 'Enlace no válido.');
    }
  });

  // --- ACCIONES DE ADMINISTRACIÓN (/ADMIN) ---
  socket.on('admin-login', (pin) => {
    if (pin === ADMIN_PIN) {
      socket.emit('admin-auth-success');
    } else {
      socket.emit('admin-auth-fail', 'PIN Incorrecto');
    }
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
  console.log(`=================================================`);
  console.log(` Servidor Nealtican Gym activo en http://localhost:${PORT}`);
  console.log(` Panel Admin disponible en: http://localhost:${PORT}/admin`);
  console.log(`=================================================`);
}); 
