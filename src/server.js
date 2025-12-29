import { logger } from './logger.js';
import { runSync } from './sync.js';
import { getLatestRunStatus } from './storage.js';

const PORT = process.env.PORT || 3000;

// HTML UI
const HTML = `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Palmeiras Calendar Sync ⚽</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      background: linear-gradient(135deg, #006b3c 0%, #00a859 100%);
      min-height: 100vh;
      padding: 20px;
      color: #333;
    }
    .container {
      max-width: 800px;
      margin: 0 auto;
      background: white;
      border-radius: 12px;
      box-shadow: 0 10px 40px rgba(0,0,0,0.2);
      overflow: hidden;
    }
    .header {
      background: #006b3c;
      color: white;
      padding: 30px;
      text-align: center;
    }
    .header h1 {
      font-size: 2em;
      margin-bottom: 10px;
    }
    .content {
      padding: 30px;
    }
    .status-card {
      background: #f8f9fa;
      border-radius: 8px;
      padding: 20px;
      margin-bottom: 20px;
      border-left: 4px solid #006b3c;
    }
    .status-badge {
      display: inline-block;
      padding: 6px 12px;
      border-radius: 20px;
      font-size: 0.85em;
      font-weight: 600;
      margin-bottom: 10px;
    }
    .status-success {
      background: #d4edda;
      color: #155724;
    }
    .status-error {
      background: #f8d7da;
      color: #721c24;
    }
    .status-pending {
      background: #fff3cd;
      color: #856404;
    }
    .status-no-runs {
      background: #e2e3e5;
      color: #383d41;
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
      gap: 15px;
      margin-top: 15px;
    }
    .stat {
      text-align: center;
      padding: 15px;
      background: white;
      border-radius: 8px;
      border: 1px solid #dee2e6;
    }
    .stat-value {
      font-size: 2em;
      font-weight: bold;
      color: #006b3c;
      margin-bottom: 5px;
    }
    .stat-label {
      font-size: 0.85em;
      color: #6c757d;
      text-transform: uppercase;
    }
    .button {
      background: #006b3c;
      color: white;
      border: none;
      padding: 15px 30px;
      font-size: 1.1em;
      border-radius: 8px;
      cursor: pointer;
      width: 100%;
      font-weight: 600;
      transition: background 0.3s;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
    }
    .button:hover:not(:disabled) {
      background: #005a2f;
    }
    .button:disabled {
      background: #6c757d;
      cursor: not-allowed;
    }
    .loading {
      display: inline-block;
      width: 16px;
      height: 16px;
      border: 2px solid #ffffff;
      border-top-color: transparent;
      border-radius: 50%;
      animation: spin 0.6s linear infinite;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    .error-list {
      margin-top: 15px;
      padding-top: 15px;
      border-top: 1px solid #dee2e6;
    }
    .error-item {
      padding: 10px;
      background: #fff;
      border-left: 3px solid #dc3545;
      margin-bottom: 8px;
      border-radius: 4px;
      font-size: 0.9em;
    }
    .timestamp {
      color: #6c757d;
      font-size: 0.85em;
      margin-top: 10px;
    }
    .message {
      margin-top: 10px;
      padding: 12px;
      background: #e7f3ff;
      border-radius: 6px;
      border-left: 3px solid #0066cc;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>⚽ Palmeiras Calendar Sync</h1>
      <p>Sincronização automática de jogos do Palmeiras</p>
    </div>
    <div class="content">
      <div class="status-card" id="statusCard">
        <div id="statusBadge"></div>
        <h2 id="statusTitle">Carregando...</h2>
        <div id="statusContent"></div>
      </div>
      
      <button class="button" id="syncButton" onclick="triggerSync()">
        🔄 Executar Sincronização
      </button>
      
      <div id="message" style="display: none;" class="message"></div>
    </div>
  </div>

  <script>
    let isSyncing = false;

    async function loadStatus() {
      try {
        const response = await fetch('/api/status');
        const data = await response.json();
        updateUI(data);
      } catch (err) {
        logger.error('[SERVER] Failed to load status', err);
        showMessage('Erro ao carregar status', 'error');
      }
    }

    function updateUI(data) {
      const statusCard = document.getElementById('statusCard');
      const statusBadge = document.getElementById('statusBadge');
      const statusTitle = document.getElementById('statusTitle');
      const statusContent = document.getElementById('statusContent');
      const syncButton = document.getElementById('syncButton');

      // Status badge
      let badgeClass = 'status-no-runs';
      let badgeText = 'Sem execuções';
      
      if (data.status === 'success') {
        badgeClass = 'status-success';
        badgeText = '✅ Sucesso';
      } else if (data.status === 'error') {
        badgeClass = 'status-error';
        badgeText = '❌ Erro';
      } else if (data.status === 'running') {
        badgeClass = 'status-pending';
        badgeText = '🔄 Executando...';
      }

      statusBadge.className = 'status-badge ' + badgeClass;
      statusBadge.textContent = badgeText;

      // Title
      if (data.status === 'no_runs') {
        statusTitle.textContent = 'Nenhuma sincronização executada ainda';
        statusContent.innerHTML = '<p>Clique no botão abaixo para executar a primeira sincronização.</p>';
        syncButton.disabled = false;
        return;
      }

      if (data.status === 'running') {
        statusTitle.textContent = 'Sincronização em andamento...';
        statusContent.innerHTML = '<p>Aguarde enquanto os jogos são sincronizados.</p>';
        syncButton.disabled = true;
        return;
      }

      statusTitle.textContent = data.message || 'Status da Sincronização';

      // Stats
      let statsHTML = '<div class="stats">';
      if (data.fixturesFound !== undefined) {
        statsHTML += \`
          <div class="stat">
            <div class="stat-value">\${data.fixturesFound}</div>
            <div class="stat-label">Jogos Encontrados</div>
          </div>
          <div class="stat">
            <div class="stat-value">\${data.created || 0}</div>
            <div class="stat-label">Criados</div>
          </div>
          <div class="stat">
            <div class="stat-value">\${data.updated || 0}</div>
            <div class="stat-label">Atualizados</div>
          </div>
          <div class="stat">
            <div class="stat-value">\${data.skipped || 0}</div>
            <div class="stat-label">Erros</div>
          </div>
        \`;
      }
      statsHTML += '</div>';

      // Duration
      if (data.duration) {
        const seconds = (data.duration / 1000).toFixed(2);
        statsHTML += \`<div class="timestamp">⏱️ Duração: \${seconds}s</div>\`;
      }

      // Timestamps
      if (data.startTime) {
        const startDate = new Date(data.startTime).toLocaleString('pt-BR');
        statsHTML += \`<div class="timestamp">🕐 Iniciado em: \${startDate}</div>\`;
      }
      if (data.endTime) {
        const endDate = new Date(data.endTime).toLocaleString('pt-BR');
        statsHTML += \`<div class="timestamp">🕐 Finalizado em: \${endDate}</div>\`;
      }

      // Errors
      if (data.errors && data.errors.length > 0) {
        statsHTML += '<div class="error-list"><strong>Erros:</strong>';
        data.errors.forEach(err => {
          const msg = err.fixture ? \`\${err.fixture}: \${err.error}\` : err.error;
          statsHTML += \`<div class="error-item">❌ \${msg}</div>\`;
        });
        statsHTML += '</div>';
      }

      statusContent.innerHTML = statsHTML;
      syncButton.disabled = isSyncing;
    }

    async function triggerSync() {
      if (isSyncing) return;
      
      isSyncing = true;
      const syncButton = document.getElementById('syncButton');
      syncButton.disabled = true;
      syncButton.innerHTML = '<span class="loading"></span> Executando...';
      
      // Update UI to show running state
      updateUI({ status: 'running' });
      showMessage('Sincronização iniciada...', 'info');

      try {
        const response = await fetch('/api/sync', { method: 'POST' });
        const data = await response.json();
        
        if (response.ok) {
          showMessage('✅ Sincronização concluída com sucesso!', 'success');
          await loadStatus();
        } else {
          showMessage(\`❌ Erro: \${data.error || 'Falha na sincronização'}\`, 'error');
          await loadStatus();
        }
      } catch (err) {
        showMessage(\`❌ Erro ao executar sincronização: \${err.message}\`, 'error');
        await loadStatus();
      } finally {
        isSyncing = false;
        syncButton.disabled = false;
        syncButton.innerHTML = '🔄 Executar Sincronização';
      }
    }

    function showMessage(text, type) {
      const messageDiv = document.getElementById('message');
      messageDiv.textContent = text;
      messageDiv.style.display = 'block';
      messageDiv.style.background = type === 'error' ? '#f8d7da' : type === 'success' ? '#d4edda' : '#e7f3ff';
      messageDiv.style.borderLeftColor = type === 'error' ? '#dc3545' : type === 'success' ? '#28a745' : '#0066cc';
      
      setTimeout(() => {
        messageDiv.style.display = 'none';
      }, 5000);
    }

    // Load status on page load and refresh every 10 seconds
    loadStatus();
    setInterval(loadStatus, 10000);
  </script>
</body>
</html>
`;

export function createServer() {
  const server = Bun.serve({
    port: PORT,
    async fetch(req) {
      const url = new URL(req.url);
      
      // Serve UI
      if (url.pathname === '/' || url.pathname === '/index.html') {
        return new Response(HTML, {
          headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
      }
      
      // API: Get status
      if (url.pathname === '/api/status' && req.method === 'GET') {
        try {
          const status = await getLatestRunStatus();
          return Response.json(status);
        } catch (err) {
          return Response.json({ error: err.message }, { status: 500 });
        }
      }
      
      // API: Trigger sync
      if (url.pathname === '/api/sync' && req.method === 'POST') {
        try {
          // Save running status immediately
          const { saveRunStatus } = await import('./storage.js');
          await saveRunStatus({
            runId: `sync-${Date.now()}`,
            status: 'running',
            startTime: new Date().toISOString(),
            message: 'Sync in progress...'
          });
          
          // Run sync in background
          runSync().catch(err => {
            logger.error('[SERVER] Background sync failed', err);
          });
          
          return Response.json({ 
            message: 'Sync started',
            status: 'running'
          });
        } catch (err) {
          return Response.json({ error: err.message }, { status: 500 });
        }
      }
      
      // Health check
      if (url.pathname === '/health' || url.pathname === '/') {
        return Response.json({ status: 'ok', service: 'palmeiras-calendar-sync' });
      }
      
      return new Response('Not Found', { status: 404 });
    },
  });

  logger.info(`🚀 Server running on http://localhost:${server.port}`);
  logger.info(`📊 Dashboard: http://localhost:${server.port}/`);
  logger.info(`🔍 Health check: http://localhost:${server.port}/health`);
  
  return server;
}

