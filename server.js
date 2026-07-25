const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { exec, spawn } = require('child_process');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// Archivos estáticos
app.use('/styles', express.static(path.join(__dirname, 'styles')));
app.use('/mobile', express.static(path.join(__dirname, 'pages/mobile')));
app.use('/tv', express.static(path.join(__dirname, 'pages/tv')));

// Rutas
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'pages/mobile/index.html')));
app.get('/tv1', (req, res) => res.sendFile(path.join(__dirname, 'pages/tv/index.html')));
app.get('/tv2', (req, res) => res.sendFile(path.join(__dirname, 'pages/tv/index.html')));

let musicQueue = [];
let currentSong = null;
let currentAudioProcess = null; // Guardará el proceso del reproductor de audio mpv

/**
 * Extrae metadata, stream de video y stream de audio con yt-dlp
 */
function getMediaData(youtubeUrl) {
  return new Promise((resolve, reject) => {
    // --dump-json para obtener URLs separadas de audio y video
    const command = `yt-dlp -f "best[ext=mp4]/best" --dump-json --no-playlist "${youtubeUrl}"`;

    exec(command, { maxBuffer: 1024 * 1024 * 15 }, async (error, stdout, stderr) => {
      if (error) {
        console.error('Error yt-dlp:', stderr);
        return reject(error);
      }
      try {
        const data = JSON.parse(stdout);
        
        // Obtener URL directa de solo audio para el servidor mpv
        const audioUrl = await getAudioOnlyUrl(youtubeUrl);

        resolve({
          url: youtubeUrl,
          title: data.title || 'Canción de Gym',
          artist: data.uploader || data.channel || 'Nealtican Gym',
          thumbnail: data.thumbnail || '',
          videoUrl: data.url,
          audioUrl: audioUrl
        });
      } catch (parseErr) {
        reject(parseErr);
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
 * Reproduce el audio localmente en el Servidor (Parrot/Ubuntu) vía mpv
 */
function playServerAudio(audioUrl) {
  // Si hay un audio sonando actualmente, lo detenemos
  if (currentAudioProcess) {
    currentAudioProcess.kill();
    currentAudioProcess = null;
  }

  if (!audioUrl) return;

  console.log('[Audio Server] Reproduciendo audio por Bocina Bluetooth...');
  
  // Ejecutar mpv sin video y enviando la salida al sistema de audio de Linux
  currentAudioProcess = spawn('mpv', ['--no-video', '--no-terminal', audioUrl]);

  // Cuando mpv termina la canción, saltamos a la siguiente
  currentAudioProcess.on('close', (code) => {
    console.log(`[Audio Server] Fin de pista (código ${code}). Siguiente en fila...`);
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

  // Iniciar reproducción de audio en la PC Servidora
  playServerAudio(currentSong.audioUrl);
}

// Websockets
io.on('connection', (socket) => {
  socket.emit('update-music-queue', musicQueue);
  socket.emit('song-changed', currentSong || {
    title: 'Esperando canción...',
    artist: 'Nealtican Gym',
    thumbnail: '',
    videoUrl: null
  });

  socket.on('add-song', async (data) => {
    console.log(`[Petición Móvil] Procesando: ${data.url}`);
    
    try {
      const mediaData = await getMediaData(data.url);

      if (!currentSong) {
        currentSong = mediaData;
        io.emit('song-changed', currentSong);
        playServerAudio(currentSong.audioUrl);
      } else {
        musicQueue.push(mediaData);
        io.emit('update-music-queue', musicQueue);
      }
    } catch (err) {
      console.error('Error procesando canción:', err);
    }
  });
});

server.listen(PORT, () => {
  console.log(`=================================================`);
  console.log(` Servidor Nealtican Gym activo en http://localhost:${PORT}`);
  console.log(` Audio asignado al sistema Linux (Bocina Bluetooth)`);
  console.log(`=================================================`);
});
