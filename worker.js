export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api-wsl') {
      let targetURL = url.searchParams.get('url') || 'https://www.worldsurfleague.com/events/2026/ct/442/fiji-pro/results';

      if (!targetURL.endsWith('/results') && !targetURL.includes('/results?')) {
        targetURL = targetURL.replace(/\/main\/?$/, '') + '/results';
      }

      const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Content-Type': 'application/json'
      };

      if (request.method === 'OPTIONS') {
        return new Response(null, { headers: corsHeaders });
      }

      try {
        const headers = {
          "X-API-Key": env.ANAKIN_API_KEY,
          "Content-Type": "application/json"
        };

        const syncRes = await fetch("https://api.anakin.io/v1/scrape", {
          method: "POST",
          headers,
          body: JSON.stringify({
            url: targetURL,
            useBrowser: true,
            formats: ["markdown", "html"]
          })
        });

        if (!syncRes.ok) {
          throw new Error(`Erro no servidor Anakin: Status ${syncRes.status}`);
        }

        const syncData = await syncRes.json();
        const content = syncData.markdown || syncData.html || "";

        if (!content) {
          throw new Error("Página retornou vazia do Anakin.");
        }

        const heatsFound = [];

        // Regex para capturar pares de atletas com notas (ex: C. Houshmand 16.87 G. Medina 15.17)
        const heatRegex = /([A-Z]\.\s+[A-Za-z'-]+)\s+([\d.]+)\s+([A-Z]\.\s+[A-Za-z'-]+)\s+([\d.]+)/g;
        let match;

        while ((match = heatRegex.exec(content)) !== null) {
          const p1 = match[1].trim();
          const score1 = parseFloat(match[2]);
          const p2 = match[3].trim();
          const score2 = parseFloat(match[4]);

          let winner = null;
          if (score1 > score2) winner = p1;
          else if (score2 > score1) winner = p2;

          heatsFound.push({ p1, p2, score1, score2, winner });
        }

        // Remoção de duplicados
        const unicos = [];
        const keys = new Set();
        heatsFound.forEach(h => {
          const k = `${h.p1}-${h.p2}`;
          if (!keys.has(k)) { keys.add(k); unicos.push(h); }
        });

        if (unicos.length === 0) {
          return new Response(JSON.stringify({
            sucesso: false,
            mensagem: "Página carregada, mas o padrão das baterias não foi identificado no texto."
          }), { headers: corsHeaders });
        }

        return new Response(JSON.stringify({
          sucesso: true,
          quantidade: unicos.length,
          baterias: unicos
        }), { headers: corsHeaders });

      } catch (err) {
        return new Response(JSON.stringify({ 
          sucesso: false, 
          mensagem: "Falha na extração: " + err.message 
        }), { headers: corsHeaders });
      }
    }

    return env.ASSETS.fetch(request);
  }
};