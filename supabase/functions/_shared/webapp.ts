/**
 * Web app response formatting and static content serving.
 * Renders structured frontline responses with case history and dashboard.
 */

import type { QueryResponse } from "./types.ts";

export interface CaseHistoryItem {
  timestamp: string;
  query: string;
  disposition: string;
  treat_here: boolean | null;
  refer_urgency: string | null;
}

export function renderWebAppPage(
  caseHistory: CaseHistoryItem[] = [],
  currentResponse: QueryResponse | null = null,
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>NSTG Frontline Care — Clinical Decision Support</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: #f8f9fa;
      color: #333;
      line-height: 1.5;
    }
    .container {
      max-width: 1200px;
      margin: 0 auto;
      padding: 16px;
    }
    header {
      background: #1a472a;
      color: white;
      padding: 20px;
      margin-bottom: 24px;
      border-radius: 8px;
    }
    h1 { font-size: 24px; margin-bottom: 8px; }
    .tagline { opacity: 0.9; font-size: 14px; }

    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 24px; }
    @media (max-width: 768px) { .grid { grid-template-columns: 1fr; } }

    .card {
      background: white;
      border: 1px solid #e0e0e0;
      border-radius: 8px;
      padding: 20px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    }
    .card h2 { font-size: 18px; margin-bottom: 16px; color: #1a472a; }

    .query-form { display: grid; gap: 12px; }
    .query-form input,
    .query-form textarea,
    .query-form button {
      padding: 12px;
      border: 1px solid #ddd;
      border-radius: 6px;
      font-family: inherit;
      font-size: 14px;
    }
    .query-form textarea {
      min-height: 100px;
      resize: vertical;
    }
    .query-form button {
      background: #1a472a;
      color: white;
      cursor: pointer;
      font-weight: 600;
      border: none;
    }
    .query-form button:hover { background: #0f2c1a; }

    .response {
      background: #f0f8f4;
      border-left: 4px solid #1a472a;
      padding: 16px;
      border-radius: 6px;
      margin-bottom: 12px;
    }
    .disposition {
      display: inline-block;
      padding: 6px 12px;
      border-radius: 4px;
      font-weight: 600;
      font-size: 12px;
      margin-bottom: 12px;
    }
    .disposition.emergency { background: #fee; color: #c33; }
    .disposition.answer { background: #efe; color: #3c3; }
    .disposition.ask { background: #ffe; color: #ca0; }

    .response-field {
      margin-bottom: 12px;
    }
    .response-label {
      font-weight: 600;
      color: #666;
      font-size: 12px;
      text-transform: uppercase;
      margin-bottom: 4px;
    }
    .response-text {
      background: white;
      padding: 12px;
      border-radius: 4px;
      border: 1px solid #ddd;
    }

    .case-history {
      max-height: 400px;
      overflow-y: auto;
    }
    .history-item {
      padding: 12px;
      border-bottom: 1px solid #eee;
      cursor: pointer;
      transition: background 0.2s;
    }
    .history-item:hover { background: #f5f5f5; }
    .history-item .timestamp {
      font-size: 12px;
      color: #999;
    }
    .history-item .query {
      margin: 4px 0;
      font-weight: 500;
    }
    .history-item .disposition-badge {
      display: inline-block;
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 3px;
      margin-top: 4px;
    }

    .dashboard {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 12px;
    }
    .stat {
      background: white;
      padding: 16px;
      border-radius: 6px;
      text-align: center;
      border: 1px solid #eee;
    }
    .stat-value {
      font-size: 24px;
      font-weight: 700;
      color: #1a472a;
      margin-bottom: 4px;
    }
    .stat-label {
      font-size: 12px;
      color: #999;
      text-transform: uppercase;
    }

    .error {
      background: #fee;
      color: #c33;
      padding: 12px;
      border-radius: 6px;
      border: 1px solid #fcc;
    }
    .success {
      background: #efe;
      color: #3c3;
      padding: 12px;
      border-radius: 6px;
      border: 1px solid #cfc;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>NSTG Frontline Care</h1>
      <p class="tagline">Clinical decision support grounded in Nigeria's Standard Treatment Guidelines</p>
    </header>

    <div class="grid">
      <div class="card">
        <h2>New Query</h2>
        <form class="query-form" id="queryForm">
          <label>
            <small>Session ID (optional)</small>
            <input type="text" name="session_id" placeholder="e.g. user123">
          </label>
          <label>
            <small>Query</small>
            <textarea name="query" placeholder="Describe the patient and symptoms..." required></textarea>
          </label>
          <label>
            <small>User Type</small>
            <select name="audience" style="padding: 12px; border: 1px solid #ddd; border-radius: 6px;">
              <option value="community">Community/PPMV</option>
              <option value="clinical">Clinical/Nurse</option>
            </select>
          </label>
          <button type="submit">Get Clinical Decision</button>
          <div id="formStatus"></div>
        </form>
      </div>

      <div class="card">
        <h2>Case History</h2>
        <div class="case-history" id="caseHistory">
          ${
            caseHistory.length === 0
              ? '<p style="color: #999; text-align: center; padding: 40px 0;">No cases yet</p>'
              : caseHistory
                  .map(
                    (item) =>
                      `<div class="history-item">
                  <div class="timestamp">${new Date(item.timestamp).toLocaleString()}</div>
                  <div class="query">${escapeHtml(item.query.slice(0, 60))}...</div>
                  <span class="history-item disposition-badge" style="background: ${getDispositionColor(item.disposition).bg}; color: ${getDispositionColor(item.disposition).text};">
                    ${item.disposition}
                  </span>
                </div>`,
                  )
                  .join("")
          }
        </div>
      </div>
    </div>

    ${
      currentResponse
        ? `
    <div class="card">
      <h2>Current Response</h2>
      <span class="disposition ${getDispositionClass(currentResponse.disposition)}">
        ${currentResponse.disposition}
      </span>

      ${
        currentResponse.treat_here !== null
          ? `<div class="response-field">
        <div class="response-label">Treat Here</div>
        <div class="response-text">${currentResponse.treat_here ? "✅ Yes" : "❌ No — Refer"}</div>
      </div>`
          : ""
      }

      ${
        currentResponse.refer_urgency
          ? `<div class="response-field">
        <div class="response-label">Referral Urgency</div>
        <div class="response-text">${escapeHtml(currentResponse.refer_urgency)}</div>
      </div>`
          : ""
      }

      <div class="response-field">
        <div class="response-label">What To Do Now</div>
        <div class="response-text">
          ${
            Array.isArray(currentResponse.what_to_do_now) &&
            currentResponse.what_to_do_now.length > 0
              ? currentResponse.what_to_do_now
                  .map((step: string, i: number) => `<div>${i + 1}. ${escapeHtml(step)}</div>`)
                  .join("")
              : currentResponse.answer
          }
        </div>
      </div>

      ${
        currentResponse.ask_or_check
          ? `<div class="response-field">
        <div class="response-label">Ask or Check</div>
        <div class="response-text">${escapeHtml(currentResponse.ask_or_check)}</div>
      </div>`
          : ""
      }
    </div>
    `
        : ""
    }

    <div class="card">
      <h2>Session Dashboard</h2>
      <div class="dashboard">
        <div class="stat">
          <div class="stat-value">${caseHistory.length}</div>
          <div class="stat-label">Cases</div>
        </div>
        <div class="stat">
          <div class="stat-value">
            ${caseHistory.filter((c) => c.disposition === "EMERGENCY_ESCALATE").length}
          </div>
          <div class="stat-label">Emergencies</div>
        </div>
        <div class="stat">
          <div class="stat-value">
            ${caseHistory.filter((c) => c.treat_here === true).length}
          </div>
          <div class="stat-label">Treat Here</div>
        </div>
        <div class="stat">
          <div class="stat-value">
            ${caseHistory.filter((c) => c.disposition === "ASK_CLARIFY").length}
          </div>
          <div class="stat-label">Need Info</div>
        </div>
      </div>
    </div>
  </div>

  <script>
    document.getElementById('queryForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const formData = new FormData(e.target);
      const statusDiv = document.getElementById('formStatus');

      try {
        statusDiv.innerHTML = '<div class="success">Sending query...</div>';
        const response = await fetch('/api/' + (formData.get('audience') === 'clinical' ? 'clinical' : 'community') + '/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: formData.get('query'),
            session_id: formData.get('session_id'),
            top_k: 5,
          }),
        });

        if (response.ok) {
          statusDiv.innerHTML = '<div class="success">Response received. Refreshing...</div>';
          setTimeout(() => location.reload(), 1000);
        } else {
          statusDiv.innerHTML = '<div class="error">Error: ' + response.status + '</div>';
        }
      } catch (err) {
        statusDiv.innerHTML = '<div class="error">Network error: ' + String(err) + '</div>';
      }
    });
  </script>
</body>
</html>`;
}

function getDispositionClass(disposition: string): string {
  if (disposition.includes("EMERGENCY")) return "emergency";
  if (disposition === "ANSWER") return "answer";
  if (disposition === "ASK_CLARIFY") return "ask";
  return "answer";
}

function getDispositionColor(disposition: string): { bg: string; text: string } {
  if (disposition.includes("EMERGENCY")) return { bg: "#fee", text: "#c33" };
  if (disposition === "ANSWER") return { bg: "#efe", text: "#3c3" };
  if (disposition === "ASK_CLARIFY") return { bg: "#ffe", text: "#ca0" };
  return { bg: "#eee", text: "#666" };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
