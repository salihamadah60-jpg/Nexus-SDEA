/**
 * BlackboardPanel — live visualization of the Planner→Writer→Reviewer graph.
 * Phase 1.7 + 8.5
 */
import { useEffect, useState } from "react";

interface AuditEntry { step: number; passed: boolean; severity: string; issues: string[]; reviewerModel: string }
interface PlanStep { id: string; description: string; acceptance: string; status: string; depends_on: string[] }
interface BlackboardTask {
  id: string;
  goal: string;
  status: string;
  retries: number;
  plan: PlanStep[];
  audits: AuditEntry[];
  result?: any;
  updatedAt: number;
}

const STATUS_COLOR: Record<string, string> = {
  pending: "#666",
  planning: "#00f2ff",
  writing: "#d4af37",
  reviewing: "#9b59b6",
  done: "#2ecc71",
  stasis: "#e67e22",
  failed: "#e74c3c",
  todo: "#444",
  in_progress: "#d4af37",
};

export default function BlackboardPanel({ sessionId }: { sessionId: string | null }) {
  const [tasks, setTasks] = useState<BlackboardTask[]>([]);
  const [selected, setSelected] = useState<BlackboardTask | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    const load = async () => {
      try {
        const r = await fetch(`/api/blackboard/tasks?sessionId=${sessionId}`);
        const d = await r.json();
        setTasks(d.tasks || []);
        if (d.tasks?.[0]) setSelected(d.tasks[0]);
      } catch {}
    };
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [sessionId]);

  if (!sessionId) return <div style={emptyStyle}>Select a session to view its Blackboard.</div>;
  if (tasks.length === 0) return <div style={emptyStyle}>No Blackboard tasks yet for this session.</div>;

  return (
    <div style={{ display: "flex", height: "100%", color: "#e6e6e6", fontFamily: "monospace", fontSize: 12 }}>
      <aside style={{ width: 240, borderRight: "1px solid #222", overflowY: "auto", background: "#0a0a0f" }}>
        <div style={{ padding: 10, color: "#d4af37", fontWeight: 700, letterSpacing: 1 }}>BLACKBOARD TASKS</div>
        {tasks.map(t => (
          <button key={t.id} onClick={() => setSelected(t)} style={{
            display: "block", width: "100%", textAlign: "left", padding: 10,
            background: selected?.id === t.id ? "#1a1a25" : "transparent", border: "none",
            borderBottom: "1px solid #181820", color: "#ddd", cursor: "pointer",
          }}>
            <div style={{ color: STATUS_COLOR[t.status], fontSize: 10, textTransform: "uppercase" }}>{t.status} · ↻{t.retries}</div>
            <div style={{ marginTop: 4 }}>{t.goal.slice(0, 60)}{t.goal.length > 60 ? "…" : ""}</div>
          </button>
        ))}
      </aside>
      <main style={{ flex: 1, overflowY: "auto", padding: 16, background: "#050508" }}>
        {selected && (
          <>
            <h3 style={{ color: "#d4af37", margin: 0 }}>{selected.goal}</h3>
            <div style={{ color: STATUS_COLOR[selected.status], marginTop: 6 }}>
              ● {selected.status.toUpperCase()} — {selected.retries} retries · {selected.plan.length} steps
            </div>
            <div style={{ marginTop: 20 }}>
              {selected.plan.map((s, i) => (
                <div key={s.id} style={{
                  marginBottom: 12, padding: 10, border: `1px solid ${STATUS_COLOR[s.status] || "#333"}`,
                  borderRadius: 6, background: "#0c0c12",
                }}>
                  <div style={{ color: STATUS_COLOR[s.status] }}>
                    {i + 1}. {s.id} — {s.status}
                  </div>
                  <div style={{ marginTop: 4 }}>{s.description}</div>
                  <div style={{ color: "#888", marginTop: 4, fontSize: 10 }}>✓ {s.acceptance}</div>
                </div>
              ))}
            </div>
            <h4 style={{ color: "#00f2ff", marginTop: 20 }}>AUDIT LOG</h4>
            {selected.audits.map((a, i) => (
              <div key={i} style={{ marginBottom: 8, padding: 8, background: a.passed ? "#0e2010" : "#201010", borderRadius: 4 }}>
                <div style={{ color: a.passed ? "#2ecc71" : "#e74c3c" }}>
                  Step {a.step}: {a.passed ? "PASS" : "FAIL"} · {a.severity} · {a.reviewerModel}
                </div>
                {a.issues.length > 0 && (
                  <ul style={{ margin: "4px 0 0 16px", color: "#bbb" }}>
                    {a.issues.map((iss, k) => <li key={k}>{iss}</li>)}
                  </ul>
                )}
              </div>
            ))}
          </>
        )}
      </main>
    </div>
  );
}

const emptyStyle: React.CSSProperties = {
  padding: 20, color: "#666", fontFamily: "monospace", fontSize: 12, textAlign: "center",
};
