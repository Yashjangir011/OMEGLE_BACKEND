import express from "express";
import http from "http";
import authRoutes from "./src/routes/auth";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import cors from "cors";
import { Server } from "socket.io";

dotenv.config();

const app = express();
const server = http.createServer(app);

// Read allowed frontend URLs from .env (comma separated) or fallback to localhost
const allowedOrigins = (process.env.FRONTEND_URLS || "http://localhost:5173")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

// CORS configuration for API routes
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true); // allow mobile apps / Postman
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error("CORS policy: Origin not allowed"));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// handle preflight requests
app.options("*", cors());

// enable json + cookies
app.use(express.json());
app.use(cookieParser());

// your routes
app.use("/api/auth", authRoutes);

// test route
app.get("/", (req, res) => {
  res.send("Backend is running 🚀");
});

// socket.io setup with cors
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
    credentials: true,
  },
});

// waitingQueue holds socket IDs that clicked "Start" (find-partner)
// but aren't paired yet. First-in is matched with the next newcomer.
const waitingQueue: string[] = [];
// partnerBySocket maps a socket ID -> its current partner's socket ID.
const partnerBySocket: Map<string, string> = new Map();

function removeFromQueue(socketId: string) {
  const idx = waitingQueue.indexOf(socketId);
  if (idx !== -1) waitingQueue.splice(idx, 1);
}

function pairSockets(a: string, b: string) {
  partnerBySocket.set(a, b);
  partnerBySocket.set(b, a);
  io.to(a).emit("partner-found", { partnerId: b });
  io.to(b).emit("partner-found", { partnerId: a });
}

function tryMatch(socketId: string) {
  removeFromQueue(socketId);
  const partnerId = waitingQueue.find((id) => id !== socketId);
  if (partnerId) {
    removeFromQueue(partnerId);
    pairSockets(socketId, partnerId);
  } else {
    waitingQueue.push(socketId);
    io.to(socketId).emit("queueing");
  }
}

function endPair(socketId: string, notifyPartner = true) {
  const partnerId = partnerBySocket.get(socketId);
  if (!partnerId) return;
  partnerBySocket.delete(socketId);
  partnerBySocket.delete(partnerId);
  if (notifyPartner) {
    io.to(partnerId).emit("partner-left");
  }
}

// socket handlers
io.on("connection", (socket) => {
  console.log("a user connected:", socket.id);

  socket.on("find-partner", () => {
    tryMatch(socket.id);
  });

  socket.on("partner-message", (msg: string) => {
    const partnerId = partnerBySocket.get(socket.id);
    if (!partnerId) return;
    io.to(partnerId).emit("partner-message", { from: socket.id, message: msg });
  });

  socket.on("next", () => {
    endPair(socket.id);
    tryMatch(socket.id);
  });

  socket.on("leave", () => {
    endPair(socket.id);
    removeFromQueue(socket.id);
    socket.emit("left");
  });

  socket.on("disconnect", () => {
    console.log("user disconnected:", socket.id);
    removeFromQueue(socket.id);
    endPair(socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`server is running on port : ${PORT}`);
});
