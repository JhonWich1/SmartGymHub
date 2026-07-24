const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 1. Servir archivos estáticos (Estilos y assets)
app.use('/styles', express.static(path.join(__dirname, 'styles')));
app.use('/mobile', express.static(path.join(__dirname, 'pages/mobile')));
app.use('/tv', express.static(path.join(__dirname, 'pages/tv')));

// 2. Rutas amigables (Clean URLs)

// Si entran a http://NealticanGym/ -> Muestra el Panel Móvil
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'pages/mobile/index.html'));
});

// Si entran a http://NealticanGym/tv1 o /tv2 -> Muestra la vista de TV
app.get(['/tv1', '/tv2'], (req, res) => {
  res.sendFile(path.join(__dirname, 'pages/tv/index.html'));
});

// 3. Lógica de WebSockets (Socket.io)
let musicQueue = [];
let currentSong = null;

let tvState = {
  tv1: { mode: 'MUSIC', queue: [] },
  tv2: { mode: 'MUSIC', queue: [] }
};

io.on('connection', (socket) => {
  console.log('Cliente conectado:', socket.id);

  // Sincronización al conectar
  socket.emit('sync-state', { musicQueue, currentSong, tvState });

  // Manejo de música
  socket.on('add-music', (data) => {
    musicQueue.push(data.song);
    if (!currentSong) {
      currentSong = musicQueue.shift();
      io.emit('play-song', currentSong);
    }
    io.emit('update-music-queue', musicQueue);
  });

  // Manejo de rutinas por TV
  socket.on('add-routine', (data) => {
    const targetTv = data.tv; // 'tv1' o 'tv2'
    tvState[targetTv].queue.push(data);
    
    if (tvState[targetTv].mode === 'MUSIC') {
      tvState[targetTv].mode = 'ROUTINE';
      const currentRoutine = tvState[targetTv].queue.shift();
      io.emit('change-tv-mode', { tv: targetTv, mode: 'ROUTINE', routine: currentRoutine });
    }
  });

  // Evento al terminar la rutina
  socket.on('routine-finished', (tvId) => {
    if (tvState[tvId].queue.length > 0) {
      const nextRoutine = tvState[tvId].queue.shift();
      io.emit('change-tv-mode', { tv: tvId, mode: 'ROUTINE', routine: nextRoutine });
    } else {
      tvState[tvId].mode = 'MUSIC';
      io.emit('change-tv-mode', { tv: tvId, mode: 'MUSIC', currentSong });
    }
  });
});

const PORT = process.env.PORT || 80;
server.listen(PORT, () => {
  console.log(`🚀 Servidor NealticanGym corriendo en http://localhost:${PORT}`);
});
