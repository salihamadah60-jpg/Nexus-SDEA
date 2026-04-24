import mongoose from "mongoose";

export const messageSchema = new mongoose.Schema({
  role: String,
  content: String,
  timestamp: { type: Date, default: Date.now },
});

export const Message = mongoose.model("Message", messageSchema);

export const SessionSchema = new mongoose.Schema({
  sessionId: { type: String, required: true, unique: true },
  title: { type: String, required: true },
  messages: [messageSchema],
  lastModified: { type: Date, default: Date.now },
});

export const Session = mongoose.model("Session", SessionSchema);

export const ProjectSchema = new mongoose.Schema({
  projectId: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  description: String,
  githubRepo: String,
  lastSync: { type: Date, default: Date.now },
});

export const Project = mongoose.model("Project", ProjectSchema);
