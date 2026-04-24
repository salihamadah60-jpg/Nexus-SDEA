/**
 * Nexus Event Stream — OpenHands-inspired Action / Observation bus.
 *
 * Every meaningful operation in the SDEA loop is emitted as an Event:
 *   - ActionEvent      something Nexus (or the user) decided to do
 *   - ObservationEvent the result of doing it
 *
 * Subscribers (UI WS, journal, audit, RAG) consume from a single source of
 * truth so the chat panel, terminal panel, and file explorer never drift apart.
 */

export type EventKind =
  | "action.command"      // shell command issued
  | "action.file.write"   // file create/overwrite
  | "action.file.delete"
  | "action.file.rename"
  | "action.file.copy"
  | "action.preview.open"
  | "action.checkpoint"
  | "obs.command.result"
  | "obs.file.changed"
  | "obs.preview.ready"
  | "obs.preview.failed"
  | "obs.error"
  | "agent.thought"
  | "agent.plan";

export interface NexusEvent {
  id: string;
  kind: EventKind;
  sessionId?: string;
  taskId?: string;
  ts: number;
  payload: Record<string, any>;
}

type Listener = (e: NexusEvent) => void;

class EventStream {
  private listeners = new Set<Listener>();
  private ring: NexusEvent[] = [];
  private maxRing = 500;
  private seq = 0;

  emit(kind: EventKind, payload: Record<string, any>, opts: { sessionId?: string; taskId?: string } = {}): NexusEvent {
    const ev: NexusEvent = {
      id: `ev_${Date.now().toString(36)}_${(this.seq++).toString(36)}`,
      kind, ts: Date.now(), payload,
      sessionId: opts.sessionId, taskId: opts.taskId,
    };
    this.ring.push(ev);
    if (this.ring.length > this.maxRing) this.ring.splice(0, this.ring.length - this.maxRing);
    for (const l of this.listeners) {
      try { l(ev); } catch (err: any) { console.warn(`[EVENT] listener err: ${err?.message}`); }
    }
    return ev;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  recent(filter?: { sessionId?: string; kind?: EventKind; limit?: number }): NexusEvent[] {
    let out = this.ring;
    if (filter?.sessionId) out = out.filter(e => e.sessionId === filter.sessionId);
    if (filter?.kind) out = out.filter(e => e.kind === filter.kind);
    if (filter?.limit) out = out.slice(-filter.limit);
    return out;
  }
}

export const eventStream = new EventStream();
