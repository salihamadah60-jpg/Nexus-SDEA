/**
 * KnowledgeVaultPanel — browse / promote / demote DNA patterns. Phase 8.4
 */
import { useEffect, useState } from "react";

interface Pattern {
  id: string; intent: string; summary: string;
  uses: number; successes: number; confidence: number; tokens_saved: number;
  archived: number; last_used: number;
}

export default function KnowledgeVaultPanel() {
  const [active, setActive] = useState<Pattern[]>([]);
  const [archived, setArchived] = useState<Pattern[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [view, setView] = useState<"active" | "archived">("active");

  const reload = async () => {
    const [a, ar] = await Promise.all([
      fetch("/api/dna/active").then(r => r.json()),
      fetch("/api/dna/archived").then(r => r.json()),
    ]);
    setActive(a.patterns || []); setStats(a.stats); setArchived(ar.patterns || []);
  };
  useEffect(() => { reload(); const t = setInterval(reload, 5000); return () => clearInterval(t); }, []);

  const setOutcome = async (id: string, success: boolean) => {
    await fetch("/api/dna/record-outcome", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, success }) });
    reload();
  };
  const coldArchive = async () => {
    await fetch("/api/dna/cold-archive", { method: "POST" });
    reload();
  };

  const list = view === "active" ? active : archived;

  return (
    <div style={{ height: "100%", padding: 16, background: "#050508", color: "#e6e6e6", fontFamily: "monospace", fontSize: 12, overflowY: "auto" }}>
      <h3 style={{ color: "#d4af37", margin: "0 0 12px" }}>KNOWLEDGE VAULT</h3>
      {stats && (
        <div style={{ display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
          <Stat label="Active" value={stats.active || 0} />
          <Stat label="Archived" value={stats.archived || 0} />
          <Stat label="Avg Confidence" value={(stats.avg_confidence || 0).toFixed(2)} />
          <Stat label="Tokens Saved" value={stats.tokens_saved || 0} />
        </div>
      )}
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <button onClick={() => setView("active")} style={tabStyle(view === "active")}>ACTIVE ({active.length})</button>
        <button onClick={() => setView("archived")} style={tabStyle(view === "archived")}>ARCHIVED ({archived.length})</button>
        <button onClick={coldArchive} style={{ ...tabStyle(false), marginLeft: "auto" }}>↘ Cold Archive Stale</button>
      </div>
      {list.length === 0 ? (
        <div style={{ color: "#666", padding: 20 }}>No patterns yet. Successful builds will populate this vault.</div>
      ) : list.map(p => (
        <div key={p.id} style={{ padding: 10, marginBottom: 8, background: "#0c0c12", border: "1px solid #1a1a25", borderRadius: 6 }}>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span style={{ color: "#00f2ff", fontWeight: 700 }}>{p.id.slice(0, 12)}…</span>
            <span style={{ color: confColor(p.confidence) }}>conf {p.confidence.toFixed(2)}</span>
          </div>
          <div style={{ marginTop: 6 }}>{p.intent}</div>
          <div style={{ color: "#888", marginTop: 4, fontSize: 10 }}>uses={p.uses} ✓{p.successes} · saved≈{p.tokens_saved}t</div>
          <div style={{ marginTop: 6, display: "flex", gap: 6 }}>
            <button onClick={() => setOutcome(p.id, true)} style={btnStyle("#2ecc71")}>↑ promote</button>
            <button onClick={() => setOutcome(p.id, false)} style={btnStyle("#e74c3c")}>↓ demote</button>
          </div>
        </div>
      ))}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: any }) {
  return <div style={{ background: "#0c0c12", padding: "6px 10px", borderRadius: 4, border: "1px solid #1a1a25" }}>
    <div style={{ color: "#888", fontSize: 10 }}>{label}</div>
    <div style={{ color: "#d4af37", fontWeight: 700 }}>{value}</div>
  </div>;
}
const tabStyle = (active: boolean): React.CSSProperties => ({
  background: active ? "#d4af37" : "transparent", color: active ? "#000" : "#d4af37",
  border: "1px solid #d4af37", padding: "4px 10px", fontFamily: "monospace", fontSize: 10, cursor: "pointer", borderRadius: 3,
});
const btnStyle = (color: string): React.CSSProperties => ({
  background: "transparent", border: `1px solid ${color}`, color, padding: "2px 8px", fontSize: 10, cursor: "pointer", borderRadius: 3, fontFamily: "monospace",
});
function confColor(c: number) { return c >= 0.7 ? "#2ecc71" : c >= 0.4 ? "#d4af37" : "#e74c3c"; }
