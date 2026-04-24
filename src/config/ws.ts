import { WebSocketServer, WebSocket } from "ws";
import { Server } from "http";
import { getOrCreateShell, executeTerminalCommand } from "../services/terminalService.js";
import { spawn } from "child_process";
import { eventStream } from "../services/eventStreamService.js";

export function setupWebSocket(server: Server) {
  const wss = new WebSocketServer({ server });

  const broadcast = (data: string, sessionId?: string, taskId?: string, channel: "shell" | "journal" = "shell") => {
    wss.clients.forEach((client: any) => {
      if (client.readyState === WebSocket.OPEN) {
        if (!sessionId || client.sessionId === sessionId) {
          client.send(JSON.stringify({ type: "output", data, taskId, channel }));
        }
      }
    });
  };

  // Bridge: every kernel Action/Observation event is pushed live to subscribed clients.
  // Front-end handles the "nexus_event" envelope to refresh file tree, surface preview
  // status, and update the activity feed without a poll.
  eventStream.subscribe((ev) => {
    const payload = JSON.stringify({ type: "nexus_event", event: ev });
    wss.clients.forEach((client: any) => {
      if (client.readyState !== WebSocket.OPEN) return;
      if (ev.sessionId && client.sessionId !== ev.sessionId) return;
      client.send(payload);
    });
  });

  const globalShell = spawn("bash", [], { shell: true, cwd: process.cwd(), env: { ...process.env, TERM: "xterm-256color" } });
  globalShell.stdout.on("data", (d) => broadcast(d.toString()));
  globalShell.stderr.on("data", (d) => broadcast(`\x1b[31m\${d.toString()}\x1b[0m`));

  wss.on("connection", (ws: any, req) => {
    const url = new URL(req.url!, `http://\${req.headers.host}`);
    const sessionId = url.searchParams.get("sessionId") || undefined;
    ws.sessionId = sessionId;
    ws.send(JSON.stringify({ type: "output", data: "\r\n\x1b[32mNexus AI Sovereign Protocol Active\x1b[0m\r\n$ " }));
    ws.inputBuffer = "";
    
    ws.on("message", async (msg: any) => {
      const data = msg.toString();
      const shell = sessionId ? await getOrCreateShell(sessionId, broadcast) : globalShell;
      if (data === "\r" || data === "\n") {
        const cmd = ws.inputBuffer.trim();
        if (cmd.startsWith("nexus-") && sessionId) {
          executeTerminalCommand(cmd, sessionId, broadcast);
        }
        ws.inputBuffer = "";
      } else if (data === "\u007f") {
        ws.inputBuffer = ws.inputBuffer.slice(0, -1);
      } else {
        ws.inputBuffer += data;
      }
      shell.stdin.write(data);
    });
  });

  return { wss, broadcast };
}
