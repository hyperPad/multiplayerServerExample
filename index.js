/**
 *
 * All the libraries that we're using for this app
 */
const app = require('express')();
// hook up socket.io and our http server to express.js
const http = require('http').Server(app);
const io = require('socket.io')(http);
const uuid = require('uuid/v1');
const _ = require('lodash');

/**
 * Constants
 */
const PORT = process.env.PORT || 3000;
const NUM_ROUNDS = 10;

/**
 * Instance Variables
 */
const rooms = {};


/**
 * Will connect a socket to a specified room
 * @param socket A connected socket.io socket
 * @param room An object that represents a room from the `rooms` instance variable object
 */
const joinRoom = (socket, room) => {
  room.sockets.push(socket);
  socket.join(room.id, () => {
    // store the room id in the socket for future use
    socket.roomId = room.id;
    console.log(socket.id, "Joined", room.id);
  });
};

/**
 * Will make the socket leave any rooms that it is a part of
 * @param socket A connected socket.io socket
 */
const leaveRooms = (socket) => {
  const roomsToDelete = [];
  for (const id in rooms) {
    const room = rooms[id];
    // check to see if the socket is in the current room
    if (room.sockets.includes(socket)) {
      socket.leave(id);
      // remove the socket from the room object
      room.sockets = room.sockets.filter((item) => item !== socket);
    }
    // Prepare to delete any rooms that are now empty
    if (room.sockets.length == 0) {
      roomsToDelete.push(room);
    }
  }

  // Delete all the empty rooms that we found earlier
  for (const room of roomsToDelete) {
    delete rooms[room.id];
  }
};

/**
 * Will check to see if we have a game winner for the room.
 * @param room An object that represents a room from the `rooms` instance variable object
 * @param sendMessage Whether or not to tell each socket if they've won or lost the game
 * @returns {boolean} true if we've found a winner. false if we haven't found a winner
 */
const checkScore = (room, sendMessage = false) => {
  let winner = null;
  for (const client of room.sockets) {
    if (client.score >= NUM_ROUNDS) {
      winner = client;
      break;
    }
  }

  if (winner) {
    if (sendMessage) {
      for (const client of room.sockets) {
        client.emit('gameOver', client.id === winner.id ? "You won the game!" : "You lost the game :(");
      }
    }

    return true;
  }

  return false;
};

/**
 * At the start of each round, randomize the players positions, determine if
 * they should be "IT" or not, and increment the score if necessary
 * @param socket A connected socket.io socket
 * @param id The id sent by the client that represents the previous "IT" player.
 * If its null, we won't increment anyone's score
 */
const beginRound = (socket, id) => {
  // This is a hack to make sure this function is only being called once during
  // game play. Basically, the client needs to send us the
  if (id && socket.id !== id) {
    return;
  }

  // Get the room
  const room = rooms[socket.roomId];
  if (!room) {
    return;
  }

  // Make sure to cancel the 20 second lose round timer so we make sure we only
  // have one timer going at any point.
  if (room.timeout) {
    clearTimeout(room.timeout);
  }

  // If we've already found a game winner, we don't need to start a new round.
  if (checkScore(room)) {
    return;
  }

  // the different potential spawning positions on the game map. measured in meters.
  let positions = [
    {x: 8, y: 8},
    {x: 120, y: 8},
    {x: 120, y: 120},
    {x: 8, y: 120}
  ];
  // Shuffle each position... we're going to use some clever trickery to
  // determine where each player should be spawned. Using lodash for the the shuffle
  // functionality.
  positions = _.shuffle(positions);

  // isIt will represent the new socket that will be considered to be "IT"
  let isIt = null;
  // This is going to be a dictionary that we're going to send to every client.
  // the keys will represent the socket ID and the values will be another dictionary
  // that will represent each player.
  const output = {};

  // We're going to loop through each player in the room.
  for (const client of room.sockets) {
    // here is the trickery. We're just going to get the last object in the positions
    // array to get the position for this player. Now there will be one less choice in
    // in the positions array.
    const position = positions.pop();
    client.x = position.x;
    client.y = position.y;
    // if the player was already it, we don't want to make them it again.
    if (client.isIt) {
      // the player won the round! increment their score.
      client.score = id ? client.score + 1 : client.score;
      client.isIt = false;
    }
    // we're going to use lodash's handy isEmpty check to see if we have an IT socket already.
    // if we don't mark the current player as it! mark the as not it just in case.
    else if (_.isEmpty(isIt)) {
      client.isIt = true;
      isIt = client;
    } else {
      client.isIt = false;
    }

    // this is the sub dictionary that represents the current player.
    output[client.id] = {
      x: client.x,
      y: client.y,
      score: client.score,
      isIt: client.isIt
    }
  }

  // After all that madness, check if we have a game winner! If we do, then
  // just return out.
  if (checkScore(room, true)) {
    return;
  }

  // Tell all the players to update themselves client side
  for (const client of room.sockets) {
    client.emit('checkifit', output);
  }

  // Start the round over if the player didn't catch anyone. They've lost the round
  // so decrement their score :(. Note that setTimeout is measured in milliseconds hence
  // the multipication by 1000
  room.timeout = setTimeout(() => {
    if (isIt) {
      isIt.score = isIt.score - 1;
    }
    beginRound(socket, null);
  }, 20 * 1000);

};

/**
 * The starting point for a user connecting to our lovely little multiplayer
 * server!
 */
io.on('connection', (socket) => {

  // give each socket a random identifier so that we can determine who is who when
  // we're sending messages back and forth!
  socket.id = uuid();
  console.log('a user connected');

  /**
   * Lets us know that players have joined a room and are waiting in the waiting room.
   */
  socket.on('ready', () => {
    console.log(socket.id, "is ready!");
    const room = rooms[socket.roomId];
    // when we have two players... START THE GAME!
    if (room.sockets.length == 2) {
      // tell each player to start the game.
      for (const client of room.sockets) {
        client.emit('initGame');
      }
    }
  });

  /**
   * The game has started! Give everyone their default values and tell each client
   * about each player
   * @param data we don't actually use that so we can ignore it.
   * @param callback Respond back to the message with information about the game state
   */
  socket.on('startGame', (data, callback) => {
    const room = rooms[socket.roomId];
    if (!room) {
      return;
    }
    const others = [];
    for (const client of room.sockets) {
      client.x = 0;
      client.y = 0;
      client.score = 0;
      if (client === socket) {
        continue;
      }
      others.push({
        id: client.id,
        x: client.x,
        y: client.y,
        score: client.score,
        isIt: false,
      });
    }

    // Tell the client who they are and who everyone else is!
    const ack = {
      me: {
        id: socket.id,
        x: socket.x,
        y: socket.y,
        score: socket.score,
        isIt: false,
      },
      others
    };

    callback(ack);

    // Start the game in 5 seconds
    setTimeout(() => {
      beginRound(socket, null);
    }, 5000);
  });

  /**
   * Gets fired every time a player has moved! Then forward that message to everyone else!
   * @param data A JSON string that represents the x and y position of the player that moved. Needs to be parsed!
   */
  socket.on('moved', (data) => {
    data = JSON.parse(data);
    const room = rooms[socket.roomId];
    if (!room) {
      return;
    }
    socket.x = data.x;
    socket.y = data.y;
    // Tell everyone else about their updated position!
    for (const client of room.sockets) {
      if (client == socket) {
        continue;
      }
      client.emit(socket.id, {
        x: socket.x,
        y: socket.y,
        score: socket.score,
        isIt: socket.isIt
      });
    }
  });

  /**
   * Gets fired when the players collide! The round is over!
   */
  socket.on('collide', (id) => {
    beginRound(socket, id);
  });

  /**
   * Gets fired when someone wants to get the list of rooms. respond with the list of room names.
   */
  socket.on('getRoomNames', (data, callback) => {
    const roomNames = [];
    for (const id in rooms) {
      const {name} = rooms[id];
      const room = {name, id};
      roomNames.push(room);
    }

    callback(roomNames);
  });

  /**
   * Gets fired when a user wants to create a new room.
   */
  socket.on('createRoom', (roomName, callback) => {
    const room = {
      id: uuid(), // generate a unique id for the new room, that way we don't need to deal with duplicates.
      name: roomName,
      sockets: []
    };
    rooms[room.id] = room;
    // have the socket join the room they've just created.
    joinRoom(socket, room);
    callback();
  });

  /**
   * Gets fired when a player has joined a room.
   */
  socket.on('joinRoom', (roomId, callback) => {
    const room = rooms[roomId];
    joinRoom(socket, room);
    callback();
  });

  /**
   * Gets fired when a player leaves a room.
   */
  socket.on('leaveRoom', () => {
    leaveRooms(socket);
  });

  /**
   * Gets fired when a player disconnects from the server.
   */
  socket.on('disconnect', () => {
    console.log('user disconnected');
    leaveRooms(socket);
  });
});

http.listen(PORT, function() {
  console.log(`listening on *:${PORT}`);
});
