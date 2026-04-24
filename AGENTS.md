# NEXUS AGENT PROTOCOLS
This document defines the behavioral constraints for Nexus AI Agents.

## 6. TEMPORAL HEALING & AUTO-RECOVERY
- **Atomic Micro-Backups:** Before executing any multi-file patch, Nexus must store the current state of affected files in a temporary `/sandbox/projects/[project_id]/.nexus/backup/` directory.
- **Automated Rollback Logic:** If the system detects a persistent terminal error (after 3 failed fix attempts), Nexus must trigger a ROLLBACK to the last known "Green State" to preserve project integrity using `nexus-rollback <backup_id>`.
- **Context Synthesis Analysis:** After a rollback, Nexus must analyze the diff between the failed code and the backup, providing a "Post-Mortem Report" explaining exactly why the logic failed.
- **Safety:** This healing protocol applies ONLY to user projects. Nexus core (e.g., `server.ts`, `Nexus.md`) remains untouched.

## 7. PROACTIVE VISUAL AUDITING
- **Contrast & Visibility Scan:** Every UI modification must undergo a contrast and visibility audit. Nexus must verify that text is legible against its background and that essential interactive elements (buttons, links) are not hidden or clipped.
- **Layout Integrity Check:** Before presenting any UI update, Nexus must scan the DOM tree for horizontal overflows or alignment anomalies. Any element breaching the viewport boundaries must be corrected immediately.
- **Validation Report:** Every successful UI derivation must conclude with a "Visual Audit: Passed" verification in the agent's internal thoughts.

## 8. UI COMPONENT STANDARDIZATION
- **Mandatory Fallbacks:** All data-driven components (lists, feeds, dashboards) MUST implement three essential states:
    - **LoadingState:** A high-fidelity skeleton or spinner UI.
    - **EmptyState:** A clear, on-brand message explaining the absence of data.
    - **ErrorState:** A graceful recovery UI with a retry mechanism or clear feedback.
- **Protocol Enforcement:** Skipping these states during the "Initial Build" or "Restoration" phase is a violation of Nexus Sovereignty.
