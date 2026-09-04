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
        // Requisição para a API do Anakin.io em vez do CodeTabs
        const anakinRes = await fetch("https://api.anakin.io/v1/scrape", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${env.ANAKIN_API_KEY}`
          },
          body: JSON.stringify({
            url: targetURL,
            generateJson: true,
            prompt: "Extraia a lista de baterias de surf contendo: p1 (nome do atleta 1), p2 (nome do atleta 2) e winner (vencedor)."
          })
        });

        if (!anakinRes.ok) {
          throw new Error(`Erro no servidor Anakin: Status ${anakinRes.status}`);
        }

        const data = await anakinRes.json();
        let unicos = [];

        // 1. Tenta pegar os dados ja estruturados pela IA do Anakin
        if (data.generatedJson && Array.isArray(data.generatedJson.baterias)) {
          unicos = data.generatedJson.baterias;
        } else {
          // 2. Fallback: Se a IA não estruturar, roda seu parser nativo no HTML sem bloqueio retornado pelo Anakin
          const html = data.html || data.cleanedHtml || "";
          if (html.includes('Just a moment...') || html.includes('Attention Required!')) {
            throw new Error("O Firewall da WSL ainda bloqueou a requisição.");
          }

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

          const keys = new Set();
          heatsFound.forEach(h => {
            const k = `${h.p1}-${h.p2}`;
            if (!keys.has(k)) { keys.add(k); unicos.push(h); }
          });
        }

        if (unicos.length === 0) {
          return new Response(JSON.stringify({
            sucesso: false,
            mensagem: "Página carregada via Anakin, mas os dados das baterias não foram identificados."
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