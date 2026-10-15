const jwt = require("jsonwebtoken");
const { env } = require("../config/env");
const { loadAccountState, tokenVersionOf } = require("./accountState");

// Socket.IO only tells open pages "something changed in section X — reload";
// REST stays the source of truth and the payload never carries data. The
// handshake must present a valid, unrevoked JWT, and the server derives the
// user from it (never from anything the client claims).
let io = null;

function registerRealtime(server) {
  io = server;
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      const user = jwt.verify(`${token || ""}`, env.jwtSecret, { algorithms: ["HS256"] });
      const state = await loadAccountState(user.id);
      if (!state.isActive || state.tokenVersion !== tokenVersionOf(user)) return next(new Error("unauthorized"));
      socket.data.user = user;
      next();
    } catch {
      next(new Error("unauthorized"));
    }
  });
  io.on("connection", socket => {
    // A client joins the room of the section it is looking at. Joining a room
    // grants nothing: rooms only receive "reload" pings with no data in them.
    socket.on("section.join", payload => {
      const code = `${payload?.section || ""}`.trim().toUpperCase().slice(0, 30);
      for (const room of socket.rooms) if (room.startsWith("section:")) socket.leave(room);
      if (code) socket.join(`section:${code}`);
    });
  });
}

function emitSection(sectionCode, event, payload = {}) {
  if (!io || !sectionCode) return;
  io.to(`section:${sectionCode}`).emit(event, { at: Date.now(), ...payload });
}

function emitAll(event, payload = {}) {
  if (!io) return;
  io.emit(event, { at: Date.now(), ...payload });
}

module.exports = { emitAll, emitSection, registerRealtime };
