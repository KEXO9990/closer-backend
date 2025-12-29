import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const httpServer = createServer(app);

app.use(cors());
app.use(express.json());

const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Load data
const questions = JSON.parse(readFileSync(join(__dirname, 'data', 'questions.json'), 'utf-8'));
const challenges = JSON.parse(readFileSync(join(__dirname, 'data', 'challenges.json'), 'utf-8'));

// Game state
const rooms = new Map();

// Generate random room code
function generateRoomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// Get random question not used yet
function getRandomQuestion(usedQuestions) {
  const available = questions.filter(q => !usedQuestions.includes(q.id));
  if (available.length === 0) return null;
  return available[Math.floor(Math.random() * available.length)];
}

// Get random challenge
function getRandomChallenge(type) {
  const filtered = challenges.filter(c => c.type === type);
  return filtered[Math.floor(Math.random() * filtered.length)];
}

app.get('/', (req, res) => {
  res.json({ status: 'Closer Game Server Running', rooms: rooms.size });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('create-room', (playerName) => {
    const roomCode = generateRoomCode();
    const room = {
      code: roomCode,
      players: [{
        id: socket.id,
        name: playerName,
        socketId: socket.id
      }],
      state: 'waiting',
      usedQuestions: [],
      currentQuestion: null,
      answers: {},
      score: 0,
      round: 0
    };
    
    rooms.set(roomCode, room);
    socket.join(roomCode);
    socket.emit('room-created', { roomCode, player: room.players[0] });
    console.log(`Room created: ${roomCode}`);
  });

  socket.on('join-room', ({ roomCode, playerName }) => {
    const room = rooms.get(roomCode);
    
    if (!room) {
      socket.emit('error', { message: 'Room not found' });
      return;
    }

    if (room.players.length >= 2) {
      socket.emit('error', { message: 'Room is full' });
      return;
    }

    const player = {
      id: socket.id,
      name: playerName,
      socketId: socket.id
    };

    room.players.push(player);
    socket.join(roomCode);

    // Notify both players
    io.to(roomCode).emit('player-joined', {
      players: room.players
    });

    console.log(`Player ${playerName} joined room ${roomCode}`);
  });

  socket.on('start-game', (roomCode) => {
    const room = rooms.get(roomCode);
    if (!room || room.players.length < 2) return;

    room.state = 'playing';
    room.round = 1;
    
    const question = getRandomQuestion(room.usedQuestions);
    if (!question) return;

    room.usedQuestions.push(question.id);
    room.currentQuestion = question;
    room.answers = {};

    io.to(roomCode).emit('game-started', {
      question: question,
      round: room.round
    });

    console.log(`Game started in room ${roomCode}`);
  });

  socket.on('submit-answer', ({ roomCode, answer }) => {
    const room = rooms.get(roomCode);
    if (!room) return;

    room.answers[socket.id] = answer;

    // Check if both players answered
    if (Object.keys(room.answers).length === 2) {
      const answers = Object.values(room.answers);
      const match = answers[0].toLowerCase().trim() === answers[1].toLowerCase().trim();
      
      if (match) {
        room.score += 10;
      }

      const result = {
        match,
        answers: room.players.map(p => ({
          name: p.name,
          answer: room.answers[p.socketId]
        })),
        score: room.score,
        discussionPrompt: match ? null : room.currentQuestion.discussionPrompt
      };

      io.to(roomCode).emit('answers-revealed', result);

      // Trigger challenge after 3 seconds
      setTimeout(() => {
        const challengeTypes = ['light', 'romantic', 'deep'];
        const randomType = challengeTypes[Math.floor(Math.random() * challengeTypes.length)];
        const challenge = getRandomChallenge(randomType);

        io.to(roomCode).emit('challenge-time', challenge);
      }, 3000);
    }
  });

  socket.on('next-round', (roomCode) => {
    const room = rooms.get(roomCode);
    if (!room) return;

    room.round++;
    const question = getRandomQuestion(room.usedQuestions);
    
    if (!question) {
      io.to(roomCode).emit('game-over', { score: room.score, rounds: room.round - 1 });
      return;
    }

    room.usedQuestions.push(question.id);
    room.currentQuestion = question;
    room.answers = {};

    io.to(roomCode).emit('next-question', {
      question: question,
      round: room.round
    });
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    
    // Find and clean up room
    rooms.forEach((room, roomCode) => {
      const playerIndex = room.players.findIndex(p => p.socketId === socket.id);
      if (playerIndex !== -1) {
        room.players.splice(playerIndex, 1);
        
        if (room.players.length === 0) {
          rooms.delete(roomCode);
          console.log(`Room ${roomCode} deleted`);
        } else {
          io.to(roomCode).emit('player-left', {
            players: room.players
          });
        }
      }
    });
  });
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
