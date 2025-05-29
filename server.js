const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Serve static files
app.use(express.static('public'));

// Game rooms storage
const gameRooms = new Map();

// Game room class
class GameRoom {
    constructor(roomCode, hostId, settings) {
        this.roomCode = roomCode;
        this.hostId = hostId;
        this.players = new Map();
        this.settings = settings;
        this.gameState = {
            currentPlayerIndex: 0,
            forbiddenNumber: settings.forbiddenNumber || 5,
            round: 1,
            gameActive: false,
            nextExpectedNumber: 1,
            startTime: null
        };
        this.maxPlayers = settings.maxPlayers || 8;
    }

    addPlayer(playerId, playerData) {
        if (this.players.size >= this.maxPlayers) {
            return false;
        }
        
        this.players.set(playerId, {
            id: playerId,
            name: playerData.name,
            eliminated: false,
            score: 0,
            isHost: playerId === this.hostId,
            joinedAt: Date.now()
        });
        
        return true;
    }

    removePlayer(playerId) {
        const removed = this.players.delete(playerId);
        
        // If host left and there are other players, make someone else host
        if (playerId === this.hostId && this.players.size > 0) {
            const newHost = this.players.values().next().value;
            this.hostId = newHost.id;
            newHost.isHost = true;
        }
        
        return removed;
    }

    getPlayersArray() {
        return Array.from(this.players.values());
    }

    getActivePlayers() {
        return this.getPlayersArray().filter(p => !p.eliminated);
    }

    getCurrentPlayer() {
        const activePlayers = this.getActivePlayers();
        if (activePlayers.length === 0) return null;
        return activePlayers[this.gameState.currentPlayerIndex % activePlayers.length];
    }

    processNumber(number, playerId) {
        const player = this.players.get(playerId);
        if (!player || player.eliminated || !this.gameState.gameActive) return null;

        

        const violation = this.checkNumberViolation(number);
        
        if (violation.violated) {
            player.eliminated = true;
            const activePlayers = this.getActivePlayers();
            
            if (activePlayers.length <= 1) {
                this.gameState.gameActive = false;
                return {
                    type: 'game_end',
                    eliminated: player,
                    winner: activePlayers[0] || null,
                    reason: violation.reason,
                    nextExpectedNumber: this.gameState.nextExpectedNumber + 1
                };
            }
            
            // Skip to next expected number after elimination
            this.gameState.nextExpectedNumber++;
            
            return {
                type: 'elimination',
                eliminated: player,
                reason: violation.reason,
                nextExpectedNumber: this.gameState.nextExpectedNumber
            };
        } else {
            player.score++;
            this.gameState.nextExpectedNumber++;
            this.nextTurn();
            
            return {
                type: 'success',
                player: player,
                number: number,
                currentPlayer: this.getCurrentPlayer(),
                nextExpectedNumber: this.gameState.nextExpectedNumber
            };
        }
    }

    checkNumberViolation(number) {
        const forbidden = this.gameState.forbiddenNumber;
        
        if (number % forbidden === 0) {
            return {
                violated: true,
                reason: `${number} is a multiple of ${forbidden}`
            };
        }
        
        if (number.toString().includes(forbidden.toString())) {
            return {
                violated: true,
                reason: `${number} contains the digit ${forbidden}`
            };
        }
        
        return { violated: false };
    }

    nextTurn() {
        const activePlayers = this.getActivePlayers();
        if (activePlayers.length <= 1) {
            this.gameState.gameActive = false;
            return;
        }
        
        this.gameState.currentPlayerIndex = (this.gameState.currentPlayerIndex + 1) % activePlayers.length;
        
        // Check if we completed a round (back to first player)
        if (this.gameState.currentPlayerIndex === 0) {
            this.gameState.round++;
        }
    }

    startGame() {
        if (this.players.size < 2) {
            return false;
        }
        
        this.gameState.gameActive = true;
        this.gameState.currentPlayerIndex = 0;
        this.gameState.round = 1;
        this.gameState.nextExpectedNumber = 1;
        this.gameState.startTime = Date.now();
        
        // Reset all players
        this.players.forEach(player => {
            player.eliminated = false;
            player.score = 0;
        });
        
        return true;
    }

    resetGame() {
        this.gameState = {
            currentPlayerIndex: 0,
            forbiddenNumber: this.settings.forbiddenNumber || 5,
            round: 1,
            gameActive: false,
            nextExpectedNumber: 1,
            startTime: null
        };
        
        this.players.forEach(player => {
            player.eliminated = false;
            player.score = 0;
        });
    }
}

// Socket connection handling
io.on('connection', (socket) => {
    console.log(`Player connected: ${socket.id}`);

    // Create room
    socket.on('create_room', (data) => {
        const roomCode = generateRoomCode();
        const gameRoom = new GameRoom(roomCode, socket.id, data.settings);
        
        if (gameRoom.addPlayer(socket.id, data.player)) {
            gameRooms.set(roomCode, gameRoom);
            socket.join(roomCode);
            socket.roomCode = roomCode;
            
            socket.emit('room_created', {
                roomCode: roomCode,
                player: gameRoom.players.get(socket.id),
                gameState: gameRoom.gameState,
                players: gameRoom.getPlayersArray()
            });
            
            console.log(`Room created: ${roomCode} by ${socket.id}`);
        } else {
            socket.emit('error', { message: 'Failed to create room' });
        }
    });

    // Join room
    socket.on('join_room', (data) => {
        const { roomCode, player } = data;
        const gameRoom = gameRooms.get(roomCode);
        
        if (!gameRoom) {
            socket.emit('error', { message: 'Room not found' });
            return;
        }
        
        if (gameRoom.gameState.gameActive) {
            socket.emit('error', { message: 'Game already in progress' });
            return;
        }
        
        if (gameRoom.addPlayer(socket.id, player)) {
            socket.join(roomCode);
            socket.roomCode = roomCode;
            
            socket.emit('room_joined', {
                roomCode: roomCode,
                player: gameRoom.players.get(socket.id),
                gameState: gameRoom.gameState,
                players: gameRoom.getPlayersArray()
            });
            
            // Notify all players in room
            io.to(roomCode).emit('player_joined', {
                player: gameRoom.players.get(socket.id),
                players: gameRoom.getPlayersArray(),
                gameState: gameRoom.gameState
            });
            
            console.log(`Player ${socket.id} joined room ${roomCode}`);
        } else {
            socket.emit('error', { message: 'Room is full' });
        }
    });

    // Start game
    socket.on('start_game', () => {
        const roomCode = socket.roomCode;
        const gameRoom = gameRooms.get(roomCode);
        
        if (!gameRoom || gameRoom.hostId !== socket.id) {
            socket.emit('error', { message: 'Only host can start the game' });
            return;
        }
        
        if (!gameRoom.startGame()) {
            socket.emit('error', { message: 'Need at least 2 players to start' });
            return;
        }
        
        io.to(roomCode).emit('game_started', {
            gameState: gameRoom.gameState,
            players: gameRoom.getPlayersArray(),
            currentPlayer: gameRoom.getCurrentPlayer()
        });
        
        console.log(`Game started in room ${roomCode}`);
    });

    // Submit number
    socket.on('submit_number', (data) => {
        const roomCode = socket.roomCode;
        const gameRoom = gameRooms.get(roomCode);
        
        if (!gameRoom || !gameRoom.gameState.gameActive) {
            socket.emit('error', { message: 'Game not active' });
            return;
        }
        
        const currentPlayer = gameRoom.getCurrentPlayer();
        if (!currentPlayer || currentPlayer.id !== socket.id) {
            socket.emit('error', { message: 'Not your turn' });
            return;
        }
        
        const result = gameRoom.processNumber(data.number, socket.id);
        
        if (result) {
            io.to(roomCode).emit('number_processed', {
                ...result,
                number: data.number,
                gameState: gameRoom.gameState,
                players: gameRoom.getPlayersArray()
            });
        }
    });

    // Reset game
    socket.on('reset_game', () => {
        const roomCode = socket.roomCode;
        const gameRoom = gameRooms.get(roomCode);
        
        if (!gameRoom || gameRoom.hostId !== socket.id) {
            socket.emit('error', { message: 'Only host can reset the game' });
            return;
        }
        
        gameRoom.resetGame();
        
        io.to(roomCode).emit('game_reset', {
            gameState: gameRoom.gameState,
            players: gameRoom.getPlayersArray()
        });
    });

    // Get room info
    socket.on('get_room_info', () => {
        const roomCode = socket.roomCode;
        const gameRoom = gameRooms.get(roomCode);
        
        if (gameRoom) {
            socket.emit('room_info', {
                roomCode: roomCode,
                players: gameRoom.getPlayersArray(),
                gameState: gameRoom.gameState,
                currentPlayer: gameRoom.getCurrentPlayer()
            });
        }
    });

    // Handle disconnection
    socket.on('disconnect', () => {
        const roomCode = socket.roomCode;
        if (roomCode) {
            const gameRoom = gameRooms.get(roomCode);
            if (gameRoom) {
                const player = gameRoom.players.get(socket.id);
                gameRoom.removePlayer(socket.id);
                
                if (gameRoom.players.size === 0) {
                    gameRooms.delete(roomCode);
                    console.log(`Room ${roomCode} deleted - no players left`);
                } else {
                    // Notify remaining players
                    io.to(roomCode).emit('player_left', {
                        player: player,
                        players: gameRoom.getPlayersArray(),
                        gameState: gameRoom.gameState,
                        newHost: gameRoom.hostId,
                        currentPlayer: gameRoom.getCurrentPlayer()
                    });
                }
            }
        }
        
        console.log(`Player disconnected: ${socket.id}`);
    });
});

// Utility functions
function generateRoomCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 6; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    
    // Ensure unique room code
    if (gameRooms.has(result)) {
        return generateRoomCode();
    }
    
    return result;
}

// Cleanup empty rooms every 30 minutes
setInterval(() => {
    const now = Date.now();
    for (const [roomCode, room] of gameRooms.entries()) {
        if (room.players.size === 0) {
            gameRooms.delete(roomCode);
            console.log(`Cleaned up empty room: ${roomCode}`);
        }
    }
}, 30 * 60 * 1000);

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Active rooms: ${gameRooms.size}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('Shutting down gracefully...');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});

module.exports = { app, server, io };