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

        let html = "";

        // 1. Tenta requisição síncrona rápida em /v1/scrape
        const syncRes = await fetch("https://api.anakin.io/v1/scrape", {
          method: "POST",
          headers,
          body: JSON.stringify({
            url: targetURL,
            formats: ["html", "cleanedHtml"]
          })
        });

        if (syncRes.ok) {
          const syncData = await syncRes.json();
          html = syncData.cleanedHtml || syncData.html || "";
        } else {
          // 2. Fallback: cria a tarefa via /v1/url-scraper conforme o Playground
          const submitRes = await fetch("https://api.anakin.io/v1/url-scraper", {
            method: "POST",
            headers,
            body: JSON.stringify({
              url: targetURL,
              country: "us",
              formats: ["html", "cleanedHtml"]
            })
          });

          if (!submitRes.ok) {
            throw new Error(`Erro no servidor Anakin: Status ${submitRes.status}`);
          }

          const jobData = await submitRes.json();
          const jobId = jobData.jobId || jobData.id;

          if (!jobId) {
            throw new Error("Não foi possível obter o ID da tarefa no Anakin.");
          }

          // Polling: Aguarda a conclusão da raspagem (até 15s)
          let attempts = 0;
          while (attempts < 15) {
            await new Promise(r => setTimeout(r, 1000));
            attempts++;

            const pollRes = await fetch(`https://api.anakin.io/v1/url-scraper/${jobId}`, { headers });
            if (pollRes.ok) {
              const result = await pollRes.json();
              if (result.status === "completed") {
                html = result.cleanedHtml || result.html || (result.data ? result.data.cleanedHtml || result.data.html : "");
                break;
              } else if (result.status === "failed") {
                throw new Error("A raspagem falhou no servidor do Anakin.");
              }
            }
          }
        }

        if (!html) {
          throw new Error("Não foi possível obter o HTML da página após a raspagem.");
        }

        // --- Extração de Baterias do HTML ---
        const clean = html.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
        const heatsFound = [];

        function traverse(obj) {
          if (!obj || typeof obj !== 'object') return;
          if (Array.isArray(obj)) return obj.forEach(traverse);

          const athletes = obj.athletes || obj.participants || obj.surfers;
          if (Array.isArray(athletes) && athletes.length >= 2) {
            const p1 = athletes[0]?.name || `${athletes[0]?.firstName || ''} ${athletes[0]?.lastName || ''}`.trim();
            const p2 = athletes[1]?.name || `${athletes[1]?.firstName || ''} ${athletes[1]?.lastName || ''}`.trim();

            if (p1 && p2 && p1 !== p2 && !p1.toLowerCase().includes('tbd')) {
              let winner = null;
              const wId = obj.winnerAthleteId || obj.winnerId || obj.winner;
              if (wId === athletes[0]?.id || wId === p1) winner = p1;
              else if (wId === athletes[1]?.id || wId === p2) winner = p2;
              heatsFound.push({ p1, p2, winner: winner || null });
            }
          }
          Object.values(obj).forEach(val => typeof val === 'object' && val !== null && traverse(val));
        }

        const match = clean.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s);
        if (match) {
          try { traverse(JSON.parse(match[1])); } catch(e) {}
        }

        if (heatsFound.length === 0) {
          const jsonBlocks = clean.match(/\{"props":[\s\S]*?\}\}\}/g) || clean.match(/\{"pageProps":[\s\S]*?\}\}/g) || [];
          for (const block of jsonBlocks) {
            try {
              traverse(JSON.parse(block));
              if (heatsFound.length > 0) break;
            } catch(e) {}
          }
        }

        const unicos = [];
        const keys = new Set();
        heatsFound.forEach(h => {
          const k = `${h.p1}-${h.p2}`;
          if (!keys.has(k)) { keys.add(k); unicos.push(h); }
        });

        if (unicos.length === 0) {
          return new Response(JSON.stringify({
            sucesso: false,
            mensagem: "Página carregada via Anakin, mas os dados das baterias não foram encontrados no HTML."
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