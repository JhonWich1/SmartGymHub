const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { exec } = require('child_process');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// Servir archivos estáticos
app.use('/styles', express.static(path.join(__dirname, 'styles')));
app.use('/mobile', express.static(path.join(__dirname, 'pages/mobile')));
app.use('/tv', express.static(path.join(__dirname, 'pages/tv')));

// Rutas de navegación
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'pages/mobile/index.html'));
});

app.get('/tv1', (req, res) => {
  res.sendFile(path.join(__dirname, 'pages/tv/index.html'));
});

app.get('/tv2', (req, res) => {
  res.sendFile(path.join(__dirname, 'pages/tv/index.html'));
});

// Estado global de la cola y reproducción
let musicQueue = [];
let currentSong = null;

/**
 * Extrae metadata completa y el stream directo de video MP4 usando yt-dlp
 * @param {string} youtubeUrl 
 * @returns {Promise<Object>}
 */
function getMediaData(youtubeUrl) {
  return new Promise((resolve, reject) => {
    // -f "best[ext=mp4]/best": Selecciona el mejor flujo de video+audio en MP4
    // --dump-json: Extrae la información estructurada sin descargar el archivo
    const command = `yt-dlp -f "best[ext=mp4]/best" --dump-json --no-playlist "${youtubeUrl}"`;

    exec(command, { maxBuffer: 1024 * 1024 * 15 }, (error, stdout, stderr) => {
      if (error) {
        console.error('Error extrayendo metadata con yt-dlp:', stderr);
        return reject(error);
      }
      try {
        const data = JSON.parse(stdout);
        resolve({
          title: data.title || 'Música Ambiental',
          artist: data.uploader || data.channel || 'Nealtican Gym',
          thumbnail: data.thumbnail || '',
          videoUrl: data.url
        });
      } catch (parseErr) {
        console.error('Error procesando JSON de yt-dlp:', parseErr);
        reject(parseErr);
      }
    });
  });
}

/**
 * Procesa y reproduce el siguiente elemento de la cola
 */
async function playNextSong() {
  if (musicQueue.length === 0) {
    currentSong = null;
    io.emit('song-changed', {
      title: 'Esperando canción...',
      artist: 'Nealtican Gym',
      thumbnail: '',
      videoUrl: null
    });
    return;
  }

  const nextItem = musicQueue.shift();
  io.emit('update-music-queue', musicQueue);

  try {
    console.log(`\n[yt-dlp] Procesando enlace: ${nextItem.url}`);
    const mediaData = await getMediaData(nextItem.url);

    currentSong = mediaData;
    console.log(`[Media Ready] Sonando: "${currentSong.title}" por ${currentSong.artist}`);
    
    io.emit('song-changed', currentSong);

  } catch (err) {
    console.error('Error procesando el enlace. Saltando a la siguiente canción...', err);
    playNextSong();
  }
}

// Control de WebSockets
io.on('connection', (socket) => {
  console.log(`[Socket] Cliente conectado: ${socket.id}`);

  // Enviar el estado actual al cliente que se acaba de conectar
  socket.emit('update-music-queue', musicQueue);

  if (currentSong) {
    socket.emit('song-changed', currentSong);
  } else {
    socket.emit('song-changed', {
      title: 'Esperando canción...',
      artist: 'Nealtican Gym',
      thumbnail: '',
      videoUrl: null
    });
  }

  // Recibir petición de canción desde el celular
  socket.on('add-song', (data) => {
    console.log(`[Socket] Canción recibida desde móvil: ${data.url}`);
    const songObj = { url: data.url };

    if (!currentSong) {
      musicQueue.push(songObj);
      playNextSong();
    } else {
      musicQueue.push(songObj);
      io.emit('update-music-queue', musicQueue);
    }
  });

  // Notificación emitida por la TV cuando el reproductor finaliza el video
  socket.on('song-ended', () => {
    console.log('[Socket] Fin de canción reportado por TV. Siguiente en fila...');
    playNextSong();
  });

  socket.on('disconnect', () => {
    console.log(`[Socket] Cliente desconectado: ${socket.id}`);
  });
});

// Iniciar servidor
server.listen(PORT, () => {
  console.log(`=================================================`);
  console.log(` Servidor Nealtican Gym listo y escuchando en:`);
  console.log(` http://localhost:${PORT}`);
  console.log(`=================================================`);
});
