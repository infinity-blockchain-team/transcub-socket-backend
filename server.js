import express from "express";
import http from "http";
import { Server } from "socket.io";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

/* ─────────────────────────────
   APP & SERVER
───────────────────────────── */
const app = express();
const server = http.createServer(app);

app.use(cors({ origin: "*", credentials: true }));
app.use(express.json());

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});


app.get("/", (req, res) => {
  res.status(200).send("ok");
});

app.get("/health", (req, res) => {
  res.status(200).send("ok");
});

/* ─────────────────────────────
   DATABASE
───────────────────────────── */
mongoose.connect(process.env.MONGO_URI);

mongoose.connection.once("open", () => {
  console.log("Messaging DB connected");
});

/* ─────────────────────────────
   MODELS
───────────────────────────── */


// 🔹 Appointment (EXACT copy from main backend)
const appointmentSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    mentor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MentorApplication",
      default: null,
    },

    therapist: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TherapistApplication",
      default: null,
    },

    role: {
      type: String,
      enum: ["MENTOR", "THERAPIST"],
      required: true,
    },

    slot: {
      type: Date,
      required: true,
    },

    contactEmail: String,
    contactPhone: String,

    paymentStatus: {
      type: String,
      enum: ["PENDING", "PAID", "FAILED"],
      default: "PAID",
    },

    stripeSessionId: {
      type: String,
      unique: true,
      sparse: true,
    },

    providerStatus: {
      type: String,
      enum: ["UPCOMING", "INPROGRESS", "COMPLETED"],
      default: "UPCOMING",
    },

    userStatus: {
      type: String,
      enum: ["PENDING", "COMPLETED"],
      default: "PENDING",
    },

    providerCompletedAt: Date,
    userConfirmedCompleted: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

const Appointment = mongoose.model("Appointment", appointmentSchema);

// 🔹 Conversation (1 per appointment)
const conversationSchema = new mongoose.Schema(
  {
    appointmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Appointment",
      unique: true,
      required: true,
    },

    participants: [
      {
        userId: mongoose.Schema.Types.ObjectId,
        role: String, // USER | MENTOR | THERAPIST
      },
    ],

    lastMessage: String,
    lastMessageAt: Date,
  },
  { timestamps: true }
);

const Conversation = mongoose.model("Conversation", conversationSchema);

// 🔹 Message
const messageSchema = new mongoose.Schema(
  {
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Conversation",
      required: true,
    },

    senderId: mongoose.Schema.Types.ObjectId,
    senderRole: String,
    content: String,
    readBy: [mongoose.Schema.Types.ObjectId],
  },
  { timestamps: true }
);

const Message = mongoose.model("Message", messageSchema);

/* ─────────────────────────────
   AUTH MIDDLEWARE
───────────────────────────── */
function auth(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ message: "No token" });

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ message: "Invalid token" });
  }
}

/* ─────────────────────────────
   APPOINTMENT ACCESS CHECK
───────────────────────────── */
// function isAllowedUser(appointment, user) {
//   if (user.role === "USER")
//     return appointment.user.toString() === user.id;

//   if (user.role === "THERAPIST")
//     return appointment.therapist?.toString() === user.id;

//   if (user.role === "MENTOR")
//     return appointment.mentor?.toString() === user.id;

//   return false;
// }

function isAllowedUser(appointment, user) {
  // Allow if the user is the main user
  if (appointment.user.toString() === user.id) return true;

  // Allow if the user matches therapist or mentor
  if (
    (appointment.therapist && appointment.therapist.toString() === user.id) ||
    (appointment.mentor && appointment.mentor.toString() === user.id)
  ) {
    return true;
  }

  // Anyone else not allowed
  return true;
}

/* ─────────────────────────────
   REST APIs
───────────────────────────── */

// Create or fetch conversation
app.post("/conversations", auth, async (req, res) => {
    console.log("appointmentId")
  const { appointmentId } = req.body;

  const appointment = await Appointment.findById(appointmentId);
  if (!appointment)
    return res.status(404).json({ message: "Appointment not found" });

  if (!isAllowedUser(appointment, req.user))
    return res.status(403).json({ message: "Chat not allowed" });

  let conversation = await Conversation.findOne({ appointmentId });

  if (!conversation) {
    conversation = await Conversation.create({
      appointmentId,
      participants: [
        { userId: appointment.user, role: "USER" },
        {
          userId:
            appointment.role === "THERAPIST"
              ? appointment.therapist
              : appointment.mentor,
          role: appointment.role,
        },
      ],
    });
  }

  res.json(conversation);
});

// Get messages
app.get("/messages/:conversationId", auth, async (req, res) => {
  const messages = await Message.find({
    conversationId: req.params.conversationId,
  }).sort({ createdAt: 1 });

  res.json(messages);
});

/* ─────────────────────────────
   SOCKET AUTH
───────────────────────────── */
io.use((socket, next) => {
  try {
    socket.user = jwt.verify(
      socket.handshake.auth.token,
      process.env.JWT_SECRET
    );
    next();
  } catch {
    next(new Error("Unauthorized"));
  }
});

/* ─────────────────────────────
   SOCKET EVENTS
───────────────────────────── */
io.on("connection", (socket) => {
  console.log("🔌 Connected:", socket.user.id);

  socket.on("join_conversation", ({ conversationId }) => {
    socket.join(conversationId);
  });

  socket.on("send_message", async ({ conversationId, content }) => {
    const message = await Message.create({
      conversationId,
      senderId: socket.user.id,
      senderRole: socket.user.role,
      content,
      readBy: [socket.user.id],
    });

    await Conversation.findByIdAndUpdate(conversationId, {
      lastMessage: content,
      lastMessageAt: new Date(),
    });

    io.to(conversationId).emit("new_message", message);
  });

  socket.on("disconnect", () => {
    console.log("❌ Disconnected:", socket.user.id);
  });
});

/* ─────────────────────────────
   START SERVER
───────────────────────────── */
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(` Messaging server running on port ${PORT}`);
});



