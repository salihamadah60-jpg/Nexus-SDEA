# Project Blueprint: Nexus AI (Synced to MongoDB)

## 1. Architecture Overview
Nexus AI is a full-stack application built with React (Vite), Express, and MongoDB. It features a high-fidelity, futuristic UI with real-time chat capabilities, neural analysis (thinking logs), and persistent memory backed by a cloud database.

## 2. File Map

### Core Frontend
- `/src/main.tsx`: Application entry point.
- `/src/App.tsx`: The heart of the application.
- `/src/index.css`: Global styling using Tailwind CSS.

### Backend & API
- `/server.ts`: Express server.
  - `GET /api/messages`: Fetches chat history.
  - `POST /api/chat`: Handles AI interaction.
  - `DELETE /api/messages`: Clears chat history.

## 3. Data Models (MongoDB)
- **Collection: `messages`**
  - `role`: "user" | "assistant" | "system"
  - `content`: string
  - `timestamp`: Date
